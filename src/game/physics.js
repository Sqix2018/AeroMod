// Bullet state that outlives loadLevel.
//
// synPhysics is created once and reused for every level, so its dynamics world
// and broadphase keep counters from whatever ran before: the substep
// accumulator (left over from unpinned play) and the dbvt broadphase's stage /
// cleanup cursor / tree-optimize path. Those change contact order and
// interpolation from load to load, so the same tape played twice split at the
// first new contact. Put them back to their construction values before a load
// and again at arm.
//
// Offsets are Bullet 2.8x layouts, checked against a live dump: world+0x160 is
// gravity (0,-10,0), +0x170 m_localTime, +0x174 m_fixedTimeStep (1/60);
// broadphase +0xa0 m_paircache ... +0xdc bools line up with btDbvtBroadphase.

const mem = require('../core/mem');

const PHYS = { broadphase: 0x8, world: 0x28 };
const WORLD = { gravityY: 0x164, localTime: 0x170, fixedTimeStep: 0x174 };
const CLEANUP_ALL = 100;
const BP = {
    opath0: 0x20,        // m_sets[0].m_opath
    opath1: 0x60,        // m_sets[1].m_opath
    stageCurrent: 0xac,
    fupdates: 0xb0,
    cupdates: 0xb8,
    newpairs: 0xbc,
    fixedleft: 0xc0,
    updatesCall: 0xc4,
    updatesDone: 0xc8,
    updatesRatio: 0xcc,
    pid: 0xd0,
    cid: 0xd4,
};

function objects() {
    const phys = mem.global('physics').readPointer();
    if (phys.isNull()) return null;
    const world = phys.add(PHYS.world).readPointer();
    const bp = phys.add(PHYS.broadphase).readPointer();
    if (world.isNull() || bp.isNull()) return null;
    return { world, bp };
}

// Refuse to write unless the layout still looks like the one we mapped.
function layoutOk(o) {
    const step = o.world.add(WORLD.fixedTimeStep).readFloat();
    const g = o.world.add(WORLD.gravityY).readFloat();
    const cup = o.bp.add(BP.cupdates).readS32();
    const fup = o.bp.add(BP.fupdates).readS32();
    const stepOk = step === 0 || Math.abs(step - 1 / 60) < 1e-4; // 0 before the first fixed step
    // cupdates is 10 from the game, 100 once a take has pinned it.
    const ok = stepOk && g < -1 && g > -100 && (cup === 10 || cup === CLEANUP_ALL) && fup === 1;
    if (!ok) layoutOk.last = `step=${step} g=${g} cupdates=${cup} fupdates=${fup}`;
    return ok;
}

function normalize(why) {
    try {
        const o = objects();
        if (o === null) return false;
        if (!layoutOk(o)) {
            console.log(`[aerox-tas] physics: layout mismatch, not normalizing (${why}) ${layoutOk.last}`);
            return false;
        }
        o.world.add(WORLD.localTime).writeFloat(0);
        o.bp.add(BP.opath0).writeU32(0);
        o.bp.add(BP.opath1).writeU32(0);
        o.bp.add(BP.stageCurrent).writeS32(0);
        o.bp.add(BP.newpairs).writeS32(1);
        o.bp.add(BP.fixedleft).writeS32(0);
        o.bp.add(BP.updatesCall).writeU32(0);
        o.bp.add(BP.updatesDone).writeU32(0);
        o.bp.add(BP.updatesRatio).writeFloat(0);
        o.bp.add(BP.pid).writeS32(0);
        o.bp.add(BP.cid).writeS32(0);
        // Stale-pair cleanup checks max(m_newpairs, pairs*cupdates/100) pairs
        // from a rotating cursor. With cupdates 10 and <10 pairs that is just
        // m_newpairs, which counts overlap reports since the last step - one
        // extra report shifted the cursor and a stale pair died a frame later
        // (9.333 vs 9.350). 100 = sweep every pair every step: removal then
        // depends only on geometry, and there are only a handful of pairs.
        o.bp.add(BP.cupdates).writeS32(CLEANUP_ALL);
        return true;
    } catch (err) {
        console.log(`[aerox-tas] physics normalize (${why}): ${err.message}`);
        return false;
    }
}

function describe() {
    try {
        const o = objects();
        if (o === null) return 'bt: none';
        const bp = o.bp;
        return `bt: localTime=${o.world.add(WORLD.localTime).readFloat().toPrecision(6)}`
            + ` stage=${bp.add(BP.stageCurrent).readS32()} newpairs=${bp.add(BP.newpairs).readS32()}`
            + ` fixedleft=${bp.add(BP.fixedleft).readS32()} calls=${bp.add(BP.updatesCall).readU32()}`
            + ` pid=${bp.add(BP.pid).readS32()} cid=${bp.add(BP.cid).readS32()}`
            + ` opath=${bp.add(BP.opath0).readU32()},${bp.add(BP.opath1).readU32()}`
            + ` gid=${bp.add(0xd8).readS32()}`;
    } catch (err) {
        return `bt: ${err.message}`;
    }
}

// The game reuses the ball's btRigidBody across loads and only resets its pose
// and velocity. The interpolation transform / velocities and the world inverse
// inertia keep the last run's values (rotation noise ~1e-8 in the tensor), and
// the solver uses that tensor on the first tick - enough to split the run a few
// hundred frames later. Rebuild them from the pose, as Bullet would.
// btRigidBody (2.8x, 0x310): +0x118 m_internalType (2 = rigid body),
// +0x180 m_invInertiaTensorWorld, +0x1d0 m_inverseMass, +0x210 m_invInertiaLocal.
const RB = {
    basis: 0x10, worldTransform: 0x10, interpTransform: 0x50,
    interpLin: 0x90, interpAng: 0xa0, internalType: 0x118,
    invInertiaWorld: 0x180, linVel: 0x1b0, angVel: 0x1c0,
    inverseMass: 0x1d0, invInertiaLocal: 0x210,
};
const f32 = Math.fround;

function cleanBody(obj) {
    if (obj.add(RB.internalType).readS32() !== 2) return 0;
    const invMass = obj.add(RB.inverseMass).readFloat();
    if (!(invMass > 0)) return 0;
    const R = [];
    for (let i = 0; i < 3; i++) {
        const row = obj.add(RB.basis + i * 16);
        R.push([row.readFloat(), row.add(4).readFloat(), row.add(8).readFloat()]);
    }
    const loc = obj.add(RB.invInertiaLocal);
    const d = [loc.readFloat(), loc.add(4).readFloat(), loc.add(8).readFloat()];
    // basis.scaled(d) * basis.transpose()
    const W = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let worst = 0;
    for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 3; k++) {
            let acc = f32(f32(R[i][0] * d[0]) * R[k][0]);
            acc = f32(acc + f32(f32(R[i][1] * d[1]) * R[k][1]));
            acc = f32(acc + f32(f32(R[i][2] * d[2]) * R[k][2]));
            W[i][k] = acc;
            const cur = obj.add(RB.invInertiaWorld + i * 16 + k * 4).readFloat();
            worst = Math.max(worst, Math.abs(cur - acc));
        }
    }
    if (!isFinite(worst) || worst > 1e-3) return -1; // not noise - leave it alone
    for (let i = 0; i < 3; i++) {
        const row = obj.add(RB.invInertiaWorld + i * 16);
        row.writeFloat(W[i][0]);
        row.add(4).writeFloat(W[i][1]);
        row.add(8).writeFloat(W[i][2]);
        row.add(12).writeFloat(0);
    }
    obj.add(RB.interpTransform).writeByteArray(obj.add(RB.worldTransform).readByteArray(0x40));
    obj.add(RB.interpLin).writeByteArray(obj.add(RB.linVel).readByteArray(16));
    obj.add(RB.interpAng).writeByteArray(obj.add(RB.angVel).readByteArray(16));
    return 1;
}

function cleanBodies() {
    const o = objects();
    if (o === null) return 'no world';
    const n = o.world.add(0x0c).readS32();
    const data = o.world.add(0x18).readPointer();
    if (n <= 0 || n > 4096 || data.isNull()) return 'no objects';
    let cleaned = 0;
    let skipped = 0;
    for (let i = 0; i < n; i++) {
        const obj = data.add(i * 8).readPointer();
        if (obj.isNull()) continue;
        try {
            const r = cleanBody(obj);
            if (r > 0) cleaned += 1;
            else if (r < 0) skipped += 1;
        } catch (err) { skipped += 1; }
    }
    return `bodies cleaned=${cleaned}${skipped ? ` skipped=${skipped}` : ''}`;
}

// loadLevel: adds the new scene's bodies while the ball is still in the world
// (its broadphase leaf wherever the last run ended), and only then removes and
// re-adds the ball. The new level's dbvt tree is built around that stale leaf,
// so pair order - and the solve - depended on how the previous run ended.
// Take the ball out first, with the world's own removeRigidBody (vtable +0xb8,
// as loadLevel: and unloadLevel do); loadLevel's later remove is then a no-op.
const WORLD_VT_REMOVE_BODY = 0xb8;
const RB_BROADPHASE_HANDLE = 0xc8;

function detachBall(why) {
    try {
        const o = objects();
        if (o === null) return false;
        const model = mem.global('ball').readPointer();
        if (model.isNull()) return false;
        const rb = model.add(require('../core/ivars').offsetOf('synNode', 'rigidBody')).readPointer();
        if (rb.isNull()) return false;
        if (rb.add(RB_BROADPHASE_HANDLE).readPointer().isNull()) return false; // not in the world
        const fn = o.world.readPointer().add(WORLD_VT_REMOVE_BODY).readPointer();
        new NativeFunction(fn, 'void', ['pointer', 'pointer'])(o.world, rb);
        return true;
    } catch (err) {
        console.log(`[aerox-tas] physics detachBall (${why}): ${err.message}`);
        return false;
    }
}

// Rebuild the broadphase from scratch at arm. Ticks between loadLevel: and
// arm vary run to run, and in those ticks the dbvt moves proxies between its
// stage lists and lazily cleans stale pairs. Resetting counters cannot undo
// that, so the same tape dropped a stale pair on a different frame each PLAY
// and the plank contacts solved in a different order (50/50 finish vs void).
// Remove every body and re-add it in the same order with the same filter,
// using the world calls loadLevel: itself uses: removeRigidBody (vt +0xb8)
// and addRigidBody(body, group, mask) (vt +0xb0).
const WORLD_VT_ADD_BODY_FILTERED = 0xb0;
// This Bullet has int filters (2.82+): group at +0x08, mask at +0x0c, and
// addRigidBody(body, int, int). Reading them as shorts gave mask 0 and every
// body stopped colliding.
const PROXY_GROUP = 0x08;
const PROXY_MASK = 0x0c;

function rebuildBroadphase(why) {
    try {
        const o = objects();
        if (o === null) return 'rebuild: no world';
        const n = o.world.add(0x0c).readS32();
        const data = o.world.add(0x18).readPointer();
        if (n <= 0 || n > 4096 || data.isNull()) return 'rebuild: no objects';
        const bodies = [];
        for (let i = 0; i < n; i++) {
            const obj = data.add(i * 8).readPointer();
            if (obj.isNull() || obj.add(RB.internalType).readS32() !== 2) {
                return `rebuild: object ${i} is not a rigid body - skipped`;
            }
            const proxy = obj.add(RB_BROADPHASE_HANDLE).readPointer();
            if (proxy.isNull()) return `rebuild: object ${i} has no proxy - skipped`;
            const group = proxy.add(PROXY_GROUP).readS32();
            const mask = proxy.add(PROXY_MASK).readS32();
            if (group === 0 || mask === 0) {
                return `rebuild: object ${i} filter ${group}/${mask} looks wrong - skipped`;
            }
            bodies.push({ obj, group, mask });
        }
        const pairsBefore = o.bp.add(0xa0).readPointer().add(0x0c).readS32();
        const vt = o.world.readPointer();
        const remove = new NativeFunction(vt.add(WORLD_VT_REMOVE_BODY).readPointer(),
            'void', ['pointer', 'pointer']);
        const add = new NativeFunction(vt.add(WORLD_VT_ADD_BODY_FILTERED).readPointer(),
            'void', ['pointer', 'pointer', 'int', 'int']);
        for (let i = bodies.length - 1; i >= 0; i--) remove(o.world, bodies[i].obj);
        normalize(why);
        for (let i = 0; i < bodies.length; i++) add(o.world, bodies[i].obj, bodies[i].group, bodies[i].mask);
        const after = o.world.add(0x0c).readS32();
        const data2 = o.world.add(0x18).readPointer();
        let same = after === n;
        for (let i = 0; same && i < n; i++) {
            if (!data2.add(i * 8).readPointer().equals(bodies[i].obj)) same = false;
        }
        const pairsAfter = o.bp.add(0xa0).readPointer().add(0x0c).readS32();
        if (pairsBefore > 0 && pairsAfter === 0) {
            console.log('[aerox-tas] physics: REBUILD LOST ALL CONTACT PAIRS - collisions are broken, stop and report');
        }
        return `rebuilt ${n} bodies pairs ${pairsBefore}->${pairsAfter}${same ? '' : ' (ORDER CHANGED)'}`;
    } catch (err) {
        return `rebuild failed: ${err.message}`;
    }
}

// btDbvt::optimizeIncremental runs every physics step on the broadphase trees
// and decides rotations with `if (node < parent)` on heap addresses. Node
// addresses differ run to run, so the tree shape - and the order new contact
// pairs are found and stale ones cleaned - did too; the same tape split
// 50/50 between finishing and the void. The rebalance only speeds up queries,
// so during a TAS take it is skipped; outside a take the game runs it as usual.
let dbvtGate = null;   // int in the CModule: 1 = skip the rebalance
let dbvtModule = null; // retained so the replacement is not collected
let dbvtFailed = false;

function installDbvtGate() {
    if (dbvtGate !== null || dbvtFailed) return dbvtGate !== null;
    try {
        const target = mem.fn('dbvtOptimizeIncremental');
        // Sanity: a real function start, not the middle of something else.
        const first = Instruction.parse(target);
        if (first === null || first.mnemonic === 'ret' || first.mnemonic === 'b') {
            throw new Error(`unexpected first instruction ${first ? first.toString() : '?'}`);
        }
        if (typeof Interceptor.replaceFast !== 'function') throw new Error('Interceptor.replaceFast missing');
        const gate = Memory.alloc(4);
        gate.writeS32(0);
        const orig = Memory.alloc(Process.pointerSize);
        dbvtModule = new CModule(`
            extern int dbvt_gate;
            extern void *dbvt_orig;
            void dbvt_opt(void *tree, int passes) {
                if (dbvt_gate) return;
                ((void (*)(void *, int))dbvt_orig)(tree, passes);
            }
        `, { dbvt_gate: gate, dbvt_orig: orig });
        const trampoline = Interceptor.replaceFast(target, dbvtModule.dbvt_opt);
        orig.writePointer(trampoline);
        dbvtGate = gate;
        console.log('[aerox-tas] physics: dbvt rebalance gated during TAS takes');
        return true;
    } catch (err) {
        dbvtFailed = true;
        console.log(`[aerox-tas] physics: dbvt gate failed: ${err.message}`);
        return false;
    }
}

function setDbvtGate(on) {
    if (dbvtGate === null) {
        if (!on) return;
        if (!installDbvtGate()) return;
    }
    const v = on ? 1 : 0;
    if (dbvtGate.readS32() !== v) dbvtGate.writeS32(v);
}

// Compact per-body fingerprint for console comparison between runs.
// Pointers and vector w padding are skipped.
// Core physical state only: pose, interpolation pose/velocities, activation
// state + deactivation timer, velocities. The rest of the struct carried bytes
// that differed between runs that behaved identically.
const DIGEST_RANGES = [[0x10, 0xb0], [0xf8, 0x100], [0x1b0, 0x1d0]];

function hashBody(obj) {
    let h = 0x811c9dc5;
    for (let r = 0; r < DIGEST_RANGES.length; r++) {
        const [from, to] = DIGEST_RANGES[r];
        for (let off = from; off < to; off += 8) {
            const lo = obj.add(off).readU32();
            const hi = off + 4 < to ? obj.add(off + 4).readU32() : 0;
            if (looksLikePtr(lo, hi)) continue;
            const words = [[off, lo], [off + 4, hi]];
            for (let k = 0; k < 2; k++) {
                if (words[k][0] >= to || (words[k][0] & 15) === 12) continue;
                h = Math.imul(h ^ words[k][1], 0x01000193) >>> 0;
            }
        }
    }
    return (h >>> 8).toString(16).padStart(6, '0');
}

function digest() {
    try {
        const o = objects();
        if (o === null) return 'no world';
        const n = o.world.add(0x0c).readS32();
        const data = o.world.add(0x18).readPointer();
        if (n <= 0 || n > 4096 || data.isNull()) return 'no objects';
        const parts = [];
        for (let i = 0; i < n; i++) {
            const obj = data.add(i * 8).readPointer();
            if (obj.isNull() || obj.add(RB.internalType).readS32() !== 2) continue;
            if (!(obj.add(RB.inverseMass).readFloat() > 0)) continue;
            // Fat broadphase box: proxy aabb (+0x20..+0x40) and its dbvt leaf
            // volume (leaf* at proxy+0x40, volume at leaf+0..+0x20).
            let vol = '-';
            try {
                const proxy = obj.add(RB_BROADPHASE_HANDLE).readPointer();
                let h = 0x811c9dc5;
                for (let k = 0x20; k < 0x40; k += 4) {
                    if ((k & 15) === 12) continue;
                    h = Math.imul(h ^ proxy.add(k).readU32(), 0x01000193) >>> 0;
                }
                const leaf = proxy.add(0x40).readPointer();
                for (let k = 0; k < 0x20; k += 4) {
                    if ((k & 15) === 12) continue;
                    h = Math.imul(h ^ leaf.add(k).readU32(), 0x01000193) >>> 0;
                }
                h = Math.imul(h ^ proxy.add(0x58).readS32(), 0x01000193) >>> 0; // stage (btDbvtProxy: leaf 0x40, links 0x48/0x50)
                vol = (h >>> 16).toString(16);
            } catch (err) { /* */ }
            parts.push(`${i}:${hashBody(obj)}/${vol}`);
        }
        let pairs = '?';
        let manifolds = '?';
        let order = '?';
        try {
            // btHashedOverlappingPairCache: pair array size +0x0c, data +0x18.
            // btBroadphasePair is 32 bytes, proxy0/proxy1 first; proxy+0 is the
            // client btCollisionObject. Hash the pair order by world index.
            const cache = o.bp.add(0xa0).readPointer();
            pairs = cache.add(0x0c).readS32();
            const pdata = cache.add(0x18).readPointer();
            const index = {};
            for (let i = 0; i < n; i++) index[data.add(i * 8).readPointer().toString()] = i;
            const list = [];
            for (let k = 0; k < pairs && k < 64; k++) {
                const pr = pdata.add(k * 32);
                const a = index[pr.readPointer().readPointer().toString()];
                const b = index[pr.add(8).readPointer().readPointer().toString()];
                list.push(`${a === undefined ? '?' : a}-${b === undefined ? '?' : b}`);
            }
            order = list.join(',');
        } catch (err) { /* */ }
        try {
            const disp = mem.global('physics').readPointer().add(0x18).readPointer();
            manifolds = disp.add(0x14).readS32();
        } catch (err) { /* */ }
        let bpState = '?';
        try {
            const bp = o.bp;
            bpState = [BP.stageCurrent, BP.cid, BP.newpairs, BP.pid, BP.fixedleft, BP.updatesCall, BP.updatesDone]
                .map(off => bp.add(off).readS32()).join('.')
                + `.${bp.add(0xde).readU8()}`; // m_needcleanup
        } catch (err) { /* */ }
        return `n=${n} bp=${bpState} pairs=${pairs}[${order}] manifolds=${manifolds} ${parts.join(' ')}`;
    } catch (err) {
        return `digest: ${err.message}`;
    }
}

// Raw state of every collision object at arm, for diffing two runs offline.
// Qwords that look like heap pointers print as P so address noise drops out.
// world+0x0c m_collisionObjects.size, +0x18 .data (btCollisionWorld).
const OBJ_BYTES = 0x200;

function looksLikePtr(lo, hi) {
    return hi >= 1 && hi <= 0x10 && lo !== 0;
}

function dumpWorld(tag, write) {
    try {
        const o = objects();
        if (o === null) return;
        const n = o.world.add(0x0c).readS32();
        const data = o.world.add(0x18).readPointer();
        if (n <= 0 || n > 4096 || data.isNull()) return;
        write(`WORLD ${tag} objects=${n} ${describe()}`);
        for (let i = 0; i < n; i++) {
            const obj = data.add(i * 8).readPointer();
            if (obj.isNull()) continue;
            const words = [];
            for (let off = 0; off < OBJ_BYTES; off += 8) {
                const lo = obj.add(off).readU32();
                const hi = obj.add(off + 4).readU32();
                if (looksLikePtr(lo, hi)) words.push('P');
                else words.push(`${lo.toString(16)}.${hi.toString(16)}`);
            }
            write(`OBJ ${tag} ${i} ${words.join(' ')}`);
        }
    } catch (err) {
        write(`WORLD ${tag} dump failed: ${err.message}`);
    }
}

module.exports = { normalize, describe, dumpWorld, cleanBodies, detachBall, digest, rebuildBroadphase, setDbvtGate };
