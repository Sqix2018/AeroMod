// Death-warp predictor (PREDICT WARP button / tas.predictWarp()).
//
// Mechanism, from the 1.9.5 decompile (FUN_1000597f8 = the game's broadphase
// filter, needBroadphaseCollision):
//
//  - The filter runs whenever Bullet pairs two AABBs. With the ball on one
//    side it switches on the other object's name. EndFlare sets the
//    level-complete flag (DAT_1002ffb97): AABB overlap alone wins.
//  - ResetPlayer (the kill volume, from Essentials.scn, added once at startup)
//    respawns the ball *inside* the filter: removeRigidBody, world transform =
//    initialWorldTransform, zero velocity, addRigidBody. The interpolation
//    transform is left at the death position.
//  - updateAabbs walks btCollisionWorld::m_collisionObjects in order; a moving
//    body's box is world U interpolation transform. removeRigidBody
//    swap-removes (the last object fills the hole); addRigidBody appends.
//
// Exact conditions for a warp on a ball death:
//  1. ARMED: the ball is not the last object in the world array. After a load
//     it is last. A movable leaving through Floor (removeRigidBody inside the
//     filter) swap-removes and moves the ball into its slot.
//  2. The ball dies in the ResetPlayer volume (the ocean). Its respawn is
//     re-appended behind the updateAabbs loop, so the same pass reaches it
//     again with a box from spawn to the death spot.
//  3. That box overlaps EndFlare's box (x, z and y - EndFlare's bottom must be
//     at or below the ball's top at the spawn).
//  4. In the static dbvt the traversal reaches EndFlare before ResetPlayer.
//     The traversal pops childs[1] first, so this is the leaf order of a
//     childs[1]-first walk and does not depend on where you die. If
//     ResetPlayer comes first it respawns the ball again mid-traversal and
//     EndFlare is never reached. The tree is rebalanced by heap address
//     outside TAS takes, so this can differ from load to load.
// After a warp or a normal death the ball is last again: the arm is spent.

const mem = require('../core/mem');
const log = require('../core/log');
const scene = require('../game/scene');
const level = require('../game/level');
const storage = require('../core/storage');

// btDbvtNode: volume min +0x00, max +0x10, childs[0] +0x28 (leaf: proxy),
// childs[1] +0x30 (0 on a leaf).
const NODE_C0 = 0x28;
const NODE_C1 = 0x30;
const MARGIN = 0.05;          // DBVT_BP_MARGIN (btDbvt::update)
const RB_USER = 0x120;        // btCollisionObject user pointer -> synNode
const RB_PROXY = 0xc8;
const BP_SET1_ROOT = 0x48;    // btDbvtBroadphase m_sets[1].m_root (static set)
const BP_SET0_ROOT = 0x08;    // m_sets[0].m_root (dynamic set)

function vec(p) { return [p.readFloat(), p.add(4).readFloat(), p.add(8).readFloat()]; }

// Rigid-body pointer -> name, built only from live scene models (level scene,
// Essentials for ResetPlayer, the ball). Tree leaves and world entries are
// matched by pointer; no ObjC call ever goes to a pointer read out of Bullet.
// Right after an arm the game has freed a body mid-callback, and messaging a
// stale pointer from there was the crash (read 0x1c / 0xd000000a8).
const names = { key: null, map: {} };

function sceneKeyOf(sc) {
    try {
        const n = scene.modelCount();
        return `${sc}/${n}/${n ? scene.modelAt(0) : 0}/${n ? scene.modelAt(n - 1) : 0}`;
    } catch (err) { return null; }
}

function bodyNameMap() {
    const sc = mem.global('scene').readPointer();
    if (sc.isNull()) return {};
    const key = sceneKeyOf(sc);
    if (key !== null && names.key === key) return names.map;
    const map = {};
    const n = scene.modelCount();
    for (let i = 0; i < n; i++) {
        const m = scene.modelAt(i);
        if (m === null) continue;
        const rb = scene.rigidBodyOf(m);
        if (rb !== null) map[rb.toString()] = scene.nameOf(m) || '?';
    }
    try {
        const es = mem.global('essentials').readPointer();
        if (!es.isNull()) {
            const o = new ObjC.Object(es);
            const count = Number(o.numModels());
            const arr = o.sceneModels();
            const base = arr.handle || arr;
            for (let i = 0; i < count; i++) {
                const m = base.add(i * Process.pointerSize).readPointer();
                if (m.isNull()) continue;
                const rb = scene.rigidBodyOf(m);
                if (rb !== null) map[rb.toString()] = scene.nameOf(m) || '?';
            }
        }
    } catch (err) { /* */ }
    try {
        const ballModel = mem.global('ball').readPointer();
        if (!ballModel.isNull()) {
            const rb = scene.rigidBodyOf(ballModel);
            if (rb !== null) map[rb.toString()] = 'ball';
        }
    } catch (err) { /* */ }
    names.key = key;
    names.map = map;
    return map;
}

// Leaves in the order btDbvt::collideTTpersistentStack visits them.
// Names come from bodyNameMap by pointer; unknown leaves are '?'.
function leafOrder(root, nameMap) {
    const map = nameMap || bodyNameMap();
    const out = [];
    const seen = {};
    function walk(p, depth) {
        if (p.isNull() || depth > 64 || seen[p.toString()]) return;
        seen[p.toString()] = true;
        const c1 = p.add(NODE_C1).readPointer();
        if (c1.isNull()) {
            let name = '?';
            try { name = map[p.add(NODE_C0).readPointer().readPointer().toString()] || '?'; } catch (err) { /* */ }
            out.push({ name, mi: vec(p), mx: vec(p.add(0x10)) });
        } else {
            walk(c1, depth + 1);
            walk(p.add(NODE_C0).readPointer(), depth + 1);
        }
    }
    walk(root, 0);
    return out;
}

function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
function fv(a) { return a ? `${f1(a[0])}, ${f1(a[1])}, ${f1(a[2])}` : '?'; }
function asArr(p) {
    if (!p) return null;
    if (Array.isArray(p)) return p;
    return isFinite(p.x) ? [p.x, p.y, p.z] : null;
}

// Death-spot condition on one axis for the spawn..death box to reach EndFlare.
function axisRule(s, lo, hi, axis) {
    if (s >= lo && s <= hi) return { text: `any ${axis}`, test: () => true };
    if (s > hi) return { text: `${axis} <= ${f1(hi)}`, test: d => d <= hi, lim: hi, dir: -1 };
    return { text: `${axis} >= ${f1(lo)}`, test: d => d >= lo, lim: lo, dir: 1 };
}

function zoneFor(spawn, ef, r, ocean) {
    const pad = r + MARGIN;
    const rx = axisRule(spawn[0], ef.mi[0] - pad, ef.mx[0] + pad, 'x');
    const rz = axisRule(spawn[2], ef.mi[2] - pad, ef.mx[2] + pad, 'z');
    const efBottom = ef.mi[1];
    const spawnTop = spawn[1] + pad;
    const heightOk = efBottom <= spawnTop;
    const span = (rule, lo, hi) => {
        if (rule.lim === undefined) return `${f1(lo)}..${f1(hi)}`;
        return rule.dir < 0 ? `${f1(lo)}..${f1(Math.min(hi, rule.lim))}` : `${f1(Math.max(lo, rule.lim))}..${f1(hi)}`;
    };
    return {
        heightOk, efBottom, spawnTop,
        text: `${rx.text}, ${rz.text}`,
        ocean: `x ${span(rx, ocean.mi[0], ocean.mx[0])}  z ${span(rz, ocean.mi[2], ocean.mx[2])}`,
        test: d => heightOk && rx.test(d[0]) && rz.test(d[2]),
        rect: {
            minX: rx.dir > 0 ? rx.lim : -240, maxX: rx.dir < 0 ? rx.lim : 240,
            minZ: rz.dir > 0 ? rz.lim : -240, maxZ: rz.dir < 0 ? rz.lim : 240,
        },
    };
}

function predict() {
    return mem.withPool(function () {
        const lv = level.levelNumber();
        const phys = mem.global('physics').readPointer();
        if (phys.isNull() || !level.inLevel()) {
            log.warn('predict: open a level first', 'warp');
            return 'open a level first';
        }
        const world = phys.add(0x28).readPointer();
        const bp = phys.add(0x8).readPointer();

        // 1. Armed: where is the ball in the world array?
        const n = world.add(0x0c).readS32();
        const data = world.add(0x18).readPointer();
        const ballModel = mem.global('ball').readPointer();
        const ballRb = ballModel.add(require('../core/ivars').offsetOf('synNode', 'rigidBody')).readPointer();
        let slot = -1;
        for (let i = 0; i < n; i++) {
            if (data.add(i * 8).readPointer().equals(ballRb)) { slot = i; break; }
        }
        const armed = slot >= 0 && slot < n - 1;

        // 4. Tree order.
        const order = leafOrder(bp.add(BP_SET1_ROOT).readPointer())
            .concat(leafOrder(bp.add(BP_SET0_ROOT).readPointer()));
        const efAt = order.findIndex(l => l.name === 'EndFlare');
        const rpAt = order.map((l, i) => (l.name === 'ResetPlayer' ? i : -1)).filter(i => i >= 0);
        if (efAt < 0 || rpAt.length === 0) {
            const msg = `L${lv}: EndFlare ${efAt < 0 ? 'not settled in the static tree' : 'ok'},`
                + ` ResetPlayer ${rpAt.length ? 'ok' : 'not found'} - try again in a second`;
            log.warn(`predict ${msg}`, 'warp');
            return msg;
        }
        const ef = order[efAt];
        const rp = order[rpAt[0]];
        const treeOk = efAt < rpAt[0];

        // Ball half extent: smallest axis of its broadphase box.
        const proxy = ballRb.add(RB_PROXY).readPointer();
        const bmi = vec(proxy.add(0x20));
        const bmx = vec(proxy.add(0x30));
        const r = Math.min.apply(null, [0, 1, 2].map(i => (bmx[i] - bmi[i]) / 2));

        log.info(`PREDICT L${lv}: armed ${armed ? 'YES' : 'no'} (ball slot ${slot + 1}/${n})`
            + `  tree: EndFlare #${efAt + 1}, ResetPlayer #${rpAt[0] + 1} of ${order.length}`
            + ` -> this load ${treeOk ? 'CAN warp' : 'cannot warp (reload to reroll the tree)'}`, 'warp');

        // 2/3. Zones per spawn: current spawn + spawns seen in recorded deaths.
        const initTf = new ObjC.Object(ballModel).initialWorldTransform();
        const spawnNow = vec((initTf.handle || initTf).add(0x30));
        const warplog = require('./warplog');
        const hits = (warplog.state.hits || []).filter(h => h && !h.miss && h.firstAfterVoid
            && asArr(h.position) && asArr(h.spawn));
        const spawns = [spawnNow];
        hits.forEach(h => {
            const s = asArr(h.spawn);
            if (!spawns.some(o => Math.abs(o[0] - s[0]) < 1 && Math.abs(o[2] - s[2]) < 1
                && Math.abs(o[1] - s[1]) < 3)) spawns.push(s);
        });
        const zones = spawns.map((s, i) => {
            const z = zoneFor(s, ef, r, rp);
            log.info(`  ${i === 0 ? 'now ' : 'seen'} spawn ${fv(s)}: `
                + (z.heightOk
                    ? `WARP ZONE ${z.text}  (ocean ${z.ocean})`
                    : `no warps - EndFlare bottom y ${f1(z.efBottom)} is above ball top ${f1(z.spawnTop)}`
                        + ` by ${f1(z.efBottom - z.spawnTop)}`), 'warp');
            return { spawn: s, z };
        });

        // Check the recorded first-after-void deaths against the zones.
        if (hits.length) {
            let wIn = 0; let wOut = 0; let nIn = 0;
            const outs = [];
            hits.forEach(h => {
                const s = asArr(h.spawn);
                const z = zoneFor(s, ef, r, rp);
                const inside = z.test(asArr(h.position));
                if (h.warp && inside) wIn += 1;
                else if (h.warp) { wOut += 1; outs.push(h); }
                else if (inside) nIn += 1;
            });
            log.info(`  recorded: ${wIn}/${wIn + wOut} warps inside their zone;`
                + ` ${nIn} normal first-after-void deaths inside a zone (tree order lost that load)`, 'warp');
            outs.slice(0, 5).forEach(h => log.info(`    warp OUTSIDE zone at ${fv(asArr(h.position))}`
                + ` spawn ${fv(asArr(h.spawn))}`, 'warp'));
        }

        // Arming = a body with mass whose broadphase box pairs Floor's box.
        // Show how far each movable's box sits above Floor's box top.
        const floor = order.find(l => l.name === 'Floor');
        if (floor) {
            const gaps = [];
            for (let i = 0; i < n; i++) {
                const obj = data.add(i * 8).readPointer();
                if (obj.equals(ballRb)) continue;
                if (!(obj.add(0x1d0).readFloat() > 0)) continue; // inverse mass
                const px = obj.add(RB_PROXY).readPointer();
                if (px.isNull()) continue;
                const lo = px.add(0x20).add(4).readFloat();
                const nm = bodyNameMap()[obj.toString()] || '?';
                gaps.push(`${nm} ${f1(lo - floor.mx[1])}`);
            }
            log.info(`  Floor box top y ${f1(floor.mx[1])}; movable box bottom above it: `
                + (gaps.length ? gaps.join(', ') : 'none (all gone or none)'), 'warp');
        }

        storage.writeJson(`warps-predict-level${String(lv).padStart(3, '0')}.json`, {
            level: lv, armed, slot, count: n, treeOk,
            endFlare: { mi: ef.mi, mx: ef.mx, order: efAt }, resetPlayer: { mi: rp.mi, mx: rp.mx, order: rpAt },
            ballHalf: r,
            zones: zones.map(({ spawn, z }) => ({ spawn, heightOk: z.heightOk, rule: z.text, ocean: z.ocean })),
        });
        const now = zones[0].z;
        return `L${lv} ${armed ? 'ARMED' : 'not armed'}, tree ${treeOk ? 'OK' : 'blocked'}, `
            + (now.heightOk ? `zone ${now.text}` : 'EndFlare too high');
    });
}

// Cheap live check for AUTO: armed (real ball slot), tree order, and the zone
// test for the current spawn. Read once per arm, not per frame.
function status() {
    return mem.withPool(function () {
        const phys = mem.global('physics').readPointer();
        if (phys.isNull()) return null;
        const world = phys.add(0x28).readPointer();
        const bp = phys.add(0x8).readPointer();
        const n = world.add(0x0c).readS32();
        const data = world.add(0x18).readPointer();
        const ballModel = mem.global('ball').readPointer();
        if (ballModel.isNull()) return null;
        const ballRb = ballModel.add(require('../core/ivars').offsetOf('synNode', 'rigidBody')).readPointer();
        let slot = -1;
        for (let i = 0; i < n; i++) {
            if (data.add(i * 8).readPointer().equals(ballRb)) { slot = i; break; }
        }
        // setAabb collides the static set first, then the dynamic set.
        const order = leafOrder(bp.add(BP_SET1_ROOT).readPointer())
            .concat(leafOrder(bp.add(BP_SET0_ROOT).readPointer()));
        const efAt = order.findIndex(l => l.name === 'EndFlare');
        const rpAt = order.findIndex(l => l.name === 'ResetPlayer');
        if (efAt < 0 || rpAt < 0) {
            return {
                settled: false, slot, n,
                why: `EndFlare ${efAt < 0 ? 'missing' : 'ok'}, ResetPlayer ${rpAt < 0 ? 'missing' : 'ok'}`
                    + ` in ${order.length} tree leaves`,
            };
        }
        const proxy = ballRb.add(RB_PROXY).readPointer();
        const bmi = vec(proxy.add(0x20));
        const bmx = vec(proxy.add(0x30));
        const r = Math.min.apply(null, [0, 1, 2].map(i => (bmx[i] - bmi[i]) / 2));
        const initTf = new ObjC.Object(ballModel).initialWorldTransform();
        const spawn = vec((initTf.handle || initTf).add(0x30));
        const zone = zoneFor(spawn, order[efAt], r, order[rpAt]);
        return {
            settled: true, slot, n,
            armed: slot >= 0 && slot < n - 1,
            treeOk: efAt < rpAt, efAt, rpAt,
            heightOk: zone.heightOk, zone, spawn,
        };
    });
}

// World list watcher: logs every body added to / removed from Bullet's world
// and every change of the ball's slot. Answers "does <effect> arm?" live.
const watch = { ptrs: null, names: {}, slot: -1, scene: null };

function nameOfBody(obj) {
    return bodyNameMap()[obj.toString()] || '?(new)';
}

function watchWorld() {
    // Only during live play. On the victory / next-level screen and during
    // loads the old scene's bodies are being freed; naming them is unsafe.
    try {
        if (!level.inLevel() || level.inMainMenu() || level.complete()
            || level.restartPending() || level.introPlaying() || !level.started()) {
            watch.ptrs = null;
            return;
        }
    } catch (err) { return; }
    try {
        const phys = mem.global('physics').readPointer();
        const sc = mem.global('scene').readPointer();
        if (phys.isNull() || sc.isNull()) { watch.ptrs = null; return; }
        const world = phys.add(0x28).readPointer();
        const n = world.add(0x0c).readS32();
        if (n <= 0 || n > 4096) return;
        const data = world.add(0x18).readPointer();
        const ptrs = [];
        for (let i = 0; i < n; i++) ptrs.push(data.add(i * 8).readPointer().toString());
        const ballModel = mem.global('ball').readPointer();
        const ballRb = ballModel.isNull() ? null
            : ballModel.add(require('../core/ivars').offsetOf('synNode', 'rigidBody')).readPointer().toString();
        const slot = ballRb === null ? -1 : ptrs.indexOf(ballRb);
        const sceneKey = sc.toString();
        if (watch.ptrs === null || watch.scene !== sceneKey) {
            // New scene: baseline only; a load adds and removes everything.
            watch.ptrs = ptrs;
            watch.slot = slot;
            watch.scene = sceneKey;
            // Addresses get reused by the next scene: always re-read names.
            watch.names = {};
            ptrs.forEach(p => { watch.names[p] = nameOfBody(ptr(p)); });
            return;
        }
        if (ptrs.length === watch.ptrs.length && slot === watch.slot
            && ptrs.every((p, i) => p === watch.ptrs[i])) return;
        const before = {};
        watch.ptrs.forEach(p => { before[p] = true; });
        const now = {};
        ptrs.forEach(p => { now[p] = true; });
        const added = ptrs.filter(p => !before[p]);
        const removed = watch.ptrs.filter(p => !now[p]);
        added.forEach(p => { watch.names[p] = nameOfBody(ptr(p)); });
        const nm = p => watch.names[p] || '?';
        const bits = [];
        if (added.length) bits.push('+' + added.map(nm).join(', +'));
        if (removed.length) bits.push('-' + removed.map(nm).join(', -'));
        if (!added.length && !removed.length) bits.push('reordered');
        const armed = slot >= 0 && slot < ptrs.length - 1;
        log.info(`world: ${bits.join('  ')}  (${ptrs.length} bodies, ball slot`
            + ` ${watch.slot + 1}->${slot + 1}/${ptrs.length}${armed ? ' ARMED' : ''})`, 'warp');
        watch.ptrs = ptrs;
        watch.slot = slot;
    } catch (err) { /* scene going away */ }
}

module.exports = { predict, leafOrder, status, watchWorld, bodyNameMap };
