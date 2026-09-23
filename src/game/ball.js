// Access to the active player ball.
//
// EAGLView::loadLevel: is the only writer of the ball global, so the pointer is
// valid the instant a level opens - no scanning, no heuristics.

const mem = require('../core/mem');
const ivars = require('../core/ivars');

const RB = mem.RB;
const TF = mem.TF;

function ivar(name) {
    return ivars.offsetOf('synNode', name);
}

function levelLoaded() {
    return !mem.global('scene').readPointer().isNull();
}

// synModel* for the ball currently in play, or null between levels.
function model() {
    if (!levelLoaded()) return null;
    const p = mem.global('ball').readPointer();
    return p.isNull() ? null : p;
}

function rigidBody() {
    const m = model();
    if (m === null) return null;
    const rb = m.add(ivar('rigidBody')).readPointer();
    return rb.isNull() ? null : rb;
}

function transform() {
    const m = model();
    if (m === null) return null;
    const t = m.add(ivar('worldTransform')).readPointer();
    return t.isNull() ? null : t;
}

// Render transform origin - the same floats the game's own FX code reads.
function position() {
    const t = transform();
    return t === null ? null : mem.readVec3(t.add(TF.origin));
}

// Physics origin; leads position() by at most one motion-state sync.
function physicsPosition() {
    const rb = rigidBody();
    return rb === null ? null : mem.readVec3(rb.add(RB.origin));
}

function velocity() {
    const rb = rigidBody();
    return rb === null ? null : mem.readVec3(rb.add(RB.linearVelocity));
}

function angularVelocity() {
    const rb = rigidBody();
    return rb === null ? null : mem.readVec3(rb.add(RB.angularVelocity));
}

function speed() {
    const v = velocity();
    return v === null ? null : mem.length3(v);
}

// initialWorldTransform is the ball's *active respawn point*: the collision
// filter overwrites it with the checkpoint transform every time one is taken,
// and the ResetPlayer branch snaps the rigid body straight back to it.
function initialTransform() {
    const m = model();
    if (m === null) return null;
    const t = new ObjC.Object(m).initialWorldTransform();
    if (t === null || t === undefined) return null;
    // Frida hands back a NativePointer for a struct-pointer return type, but an
    // ObjC.Object if the bridge decides it looks like an id.
    const p = t.handle === undefined ? t : t.handle;
    return (p instanceof NativePointer && !p.isNull()) ? p : null;
}

function initialPosition() {
    const t = initialTransform();
    return t === null ? null : mem.readVec3(t.add(TF.origin));
}

// One ObjC lookup per scene. Reading the floats after that does not retain
// the level, which is what chained loadLevel was pinning at ~40MB a try.
let spawnCache = { scene: null, ptr: null };

function spawnPosition() {
    let key = null;
    try {
        const scenePtr = mem.global('scene').readPointer();
        key = scenePtr.isNull() ? null : scenePtr.toString();
    } catch (err) { /* */ }
    if (key !== spawnCache.scene) {
        spawnCache.scene = key;
        spawnCache.ptr = key === null ? null : initialTransform();
    }
    if (spawnCache.ptr === null) return null;
    try { return mem.readVec3(spawnCache.ptr.add(TF.origin)); } catch (err) {
        spawnCache.ptr = null;
        return null;
    }
}

// Moves the respawn point. This is the same field the CheckPoint branch writes,
// so it is how the WARP tab turns a checkpoint on and off for testing.
function setInitialPosition(x, y, z) {
    const t = initialTransform();
    if (t === null) return false;
    mem.writeVec3(t.add(TF.origin), x, y, z);
    return true;
}

let setActivationState = null;
try {
    setActivationState = new NativeFunction(
        mem.fn('setActivationState'), 'void', ['pointer', 'int']);
} catch (err) {
    console.log(`[aerox-tas] setActivationState unavailable: ${err.message}`);
}

// Wake the body and reset its sleep timer, mirroring btCollisionObject::activate.
function activate(rb) {
    rb.add(RB.deactivationTime).writeFloat(0);
    if (setActivationState !== null) setActivationState(rb, 1); // ACTIVE_TAG
    else rb.add(RB.activationState).writeS32(1);
}

function bumpRevision(rb) {
    rb.add(RB.updateRevision).writeS32(rb.add(RB.updateRevision).readS32() + 1);
}

// Writes a velocity of zero length as an epsilon instead. processGameFrame
// normalises the linear velocity with an unguarded `1.0 / sqrt(|v|)`, so a true
// zero yields Inf, then NaN, which spreads into the world transform and the
// camera yaw. Yaw is a global that survives level changes, which is why a
// zeroed ball used to leave the menu rendering white.
function zeroVelocity(rb) {
    const e = mem.VELOCITY_EPSILON;
    mem.writeVec3(rb.add(RB.linearVelocity), e, e, e);
    mem.writeVec3(rb.add(RB.angularVelocity), e, e, e);
}

// Cheap repair for state that has already gone non-finite. Returns what it fixed.
function scrubNaN() {
    const fixed = [];

    const yawPtr = mem.global('cameraYaw');
    if (!isFinite(yawPtr.readFloat())) {
        yawPtr.writeFloat(mem.global('checkpointYaw').readFloat() || 0);
        if (!isFinite(yawPtr.readFloat())) yawPtr.writeFloat(0);
        fixed.push('cameraYaw');
    }

    const rb = rigidBody();
    if (rb === null) return fixed;

    if (!mem.finite3(mem.readVec3(rb.add(RB.linearVelocity)))
        || !mem.finite3(mem.readVec3(rb.add(RB.angularVelocity)))) {
        zeroVelocity(rb);
        fixed.push('velocity');
    }
    if (!mem.finite3(mem.readVec3(rb.add(RB.totalForce)))
        || !mem.finite3(mem.readVec3(rb.add(RB.totalTorque)))) {
        mem.writeVec3(rb.add(RB.totalForce), 0, 0, 0);
        mem.writeVec3(rb.add(RB.totalTorque), 0, 0, 0);
        fixed.push('forces');
    }
    if (!mem.finite3(mem.readVec3(rb.add(RB.origin)))) {
        // Fall back to the active respawn point rather than guessing.
        const spawn = initialPosition();
        if (spawn !== null && mem.finite3(spawn)) {
            teleport(spawn.x, spawn.y, spawn.z);
            fixed.push('position');
        }
    }

    if (fixed.length > 0) bumpRevision(rb);
    return fixed;
}

function physics() {
    try {
        const p = mem.global('physics').readPointer();
        return p.isNull() ? null : new ObjC.Object(p);
    } catch (err) {
        return null;
    }
}

const PROXY = mem.PROXY;
const aabbProbe = { logged: false };

function looksLikeAabb(min, max) {
    return mem.finite3(min) && mem.finite3(max)
        && min.x <= max.x && min.y <= max.y && min.z <= max.z
        && (max.x - min.x) > 0.01 && (max.x - min.x) < 400
        && (max.y - min.y) > 0.01 && (max.y - min.y) < 400
        && (max.z - min.z) > 0.01 && (max.z - min.z) < 400;
}

function proxyOf(rb) {
    if (rb === null) return null;
    const handle = rb.add(RB.broadphaseHandle).readPointer();
    if (handle.isNull()) return null;
    try {
        const client = handle.add(PROXY.clientObject).readPointer();
        if (!client.equals(rb)) return null;
    } catch (err) {
        return null;
    }
    return handle;
}

function aabbOf(rb) {
    const handle = proxyOf(rb);
    if (handle === null) return null;
    try {
        const min = mem.readVec3(handle.add(PROXY.aabbMin));
        const max = mem.readVec3(handle.add(PROXY.aabbMax));
        return looksLikeAabb(min, max) ? { min, max } : null;
    } catch (err) {
        return null;
    }
}

function aabb() {
    return aabbOf(rigidBody());
}

function leafOf(rb) {
    const handle = proxyOf(rb);
    if (handle === null) return null;
    try {
        const leaf = handle.add(PROXY.leaf).readPointer();
        if (leaf.isNull()) return null;
        const min = mem.readVec3(leaf);
        const max = mem.readVec3(leaf.add(16));
        return looksLikeAabb(min, max) ? leaf : null;
    } catch (err) {
        return null;
    }
}

function writeAabb(ptr, box) {
    mem.writeVec3(ptr, box.min.x, box.min.y, box.min.z);
    mem.writeVec3(ptr.add(16), box.max.x, box.max.y, box.max.z);
}

// Grow the fat AABB so it still contains `box`. If the next physics tick sees
// the new world box inside this fat box it will not remove+reinsert the leaf,
// which is what scrambles the dynamic tree on a normal teleport.
function inflateToward(rb, box) {
    if (rb === null || box === null) return false;
    const handle = proxyOf(rb);
    if (handle === null) return false;

    const current = aabbOf(rb);
    const grown = mem.aabbUnion(current, box);
    writeAabb(handle.add(PROXY.aabbMin), grown);

    const leaf = leafOf(rb);
    if (leaf !== null) {
        const leafBox = {
            min: mem.readVec3(leaf),
            max: mem.readVec3(leaf.add(16)),
        };
        writeAabb(leaf, mem.aabbUnion(leafBox, grown));
    }
    return true;
}

function radius() {
    const m = model();
    if (m === null) return 1;
    try {
        const r = new ObjC.Object(m).bSphereRadius();
        return (typeof r === 'number' && r > 0.2) ? r : 1;
    } catch (err) {
        return 1;
    }
}

function destBox(x, y, z) {
    const pad = radius() + 2;
    return mem.aabbAround({ x, y, z }, pad);
}

function placeBody(rb, m, x, y, z, keepVelocity) {
    bumpRevision(rb);
    mem.writeVec3(rb.add(RB.origin), x, y, z);
    mem.writeVec3(rb.add(RB.interpolationOrigin), x, y, z);
    if (keepVelocity !== true) zeroVelocity(rb);
    mem.writeVec3(rb.add(RB.totalForce), 0, 0, 0);
    mem.writeVec3(rb.add(RB.totalTorque), 0, 0, 0);

    const motionState = rb.add(RB.motionState).readPointer();
    if (!motionState.isNull()) {
        mem.writeVec3(motionState.add(RB.worldTransform + TF.origin), x, y, z);
    }
    const t = m.add(ivar('worldTransform')).readPointer();
    if (!t.isNull()) mem.writeVec3(t.add(TF.origin), x, y, z);
    activate(rb);
}

// tree: 'keep'   inflate the fat AABB, then write in place (default)
//       'raw'    write in place and let Bullet fat-teleport on the next tick
//       'relink' removeRigidBody / addRigidBody, same as a real ResetPlayer
function teleport(x, y, z, options) {
    const opts = options || {};
    const tree = opts.tree || (opts.relink === false ? 'raw'
        : opts.relink === true ? 'relink' : 'keep');
    const m = model();
    if (m === null) return false;
    const rb = m.add(ivar('rigidBody')).readPointer();
    if (rb.isNull()) return false;

    if (!aabbProbe.logged) {
        const box = aabbOf(rb);
        console.log(`[aerox-tas] ball AABB ${box === null ? 'unreadable' : mem.fmtAabb(box)}`
            + `  leaf ${leafOf(rb) === null ? 'no' : 'yes'}`);
        aabbProbe.logged = true;
    }

    const from = physicsPosition();

    if (tree === 'relink') {
        const phys = physics();
        const node = new ObjC.Object(m);
        if (phys !== null) {
            try { phys.removeRigidBodyFromModel_(node); } catch (err) { /* */ }
        }
        placeBody(rb, m, x, y, z, opts.keepVelocity);
        if (phys !== null) {
            try { phys.addRigidBodyFromModel_(node); } catch (err) { /* */ }
        }
        noteTeleportDistance(from, x, y, z, tree);
        return true;
    }

    if (tree === 'keep') inflateToward(rb, destBox(x, y, z));
    placeBody(rb, m, x, y, z, opts.keepVelocity);
    noteTeleportDistance(from, x, y, z, tree);
    return true;
}

function noteTeleportDistance(from, x, y, z, tree) {
    if (tree === 'raw' || from === null) return;
    try {
        const dx = x - from.x;
        const dy = y - from.y;
        const dz = z - from.z;
        require('../tas/achievements').noteTeleport(Math.sqrt(dx * dx + dy * dy + dz * dz));
    } catch (err) { /* */ }
}

function nudge(dx, dy, dz) {
    const p = physicsPosition();
    if (p === null) return false;
    return teleport(p.x + dx, p.y + dy, p.z + dz, { keepVelocity: true, tree: 'keep' });
}

const SAFE_SLIDE_Y = 2;

const mover = {
    dest: null,
    final: null,
    path: null,
    step: 2.5,
    phase: null,
};

function moving() {
    return mover.dest !== null || mover.path !== null;
}

function cancelMove() {
    mover.dest = null;
    mover.final = null;
    mover.path = null;
    mover.phase = null;
}

function slideTo(x, y, z, options) {
    const opts = options || {};
    const p = physicsPosition();
    if (p === null) return false;
    mover.final = { x, y, z };
    mover.path = null;
    mover.step = opts.step > 0 ? opts.step : 2.5;
    // Gravity used to pull Y down every step, so a long slide hit the kill
    // plane before XZ arrived. Hold a safe height until XZ is done, then drop.
    if (opts.direct === true || y >= SAFE_SLIDE_Y) {
        mover.dest = { x, y, z };
        mover.phase = 'direct';
    } else {
        mover.dest = { x, y: Math.max(p.y, SAFE_SLIDE_Y), z };
        mover.phase = 'xz';
    }
    return true;
}

function followPath(points, options) {
    if (!points || points.length === 0) return false;
    const opts = options || {};
    mover.path = points.slice();
    mover.dest = null;
    mover.final = null;
    mover.phase = 'path';
    mover.step = opts.step > 0 ? opts.step : 2.5;
    return true;
}

function stepToward(target, step) {
    const p = physicsPosition();
    if (p === null) return 'lost';
    const delta = mem.sub3(target, p);
    const len = mem.length3(delta);
    if (len <= step) {
        teleport(target.x, target.y, target.z, { tree: 'raw', keepVelocity: false });
        return 'done';
    }
    const s = step / len;
    teleport(p.x + delta.x * s, p.y + delta.y * s, p.z + delta.z * s,
        { tree: 'raw', keepVelocity: false });
    return 'move';
}

// After the sim, so gravity cannot sag the path between steps.
function onAfterFrame() {
    if (mover.path !== null) {
        while (mover.path.length > 0) {
            const next = mover.path[0];
            const result = stepToward(next, mover.step);
            if (result === 'lost') { cancelMove(); return; }
            if (result === 'move') return;
            mover.path.shift();
        }
        cancelMove();
        return;
    }
    if (mover.dest === null) return;
    const result = stepToward(mover.dest, mover.step);
    if (result === 'lost') { cancelMove(); return; }
    if (result === 'move') return;
    if (mover.phase === 'xz' && mover.final !== null) {
        mover.dest = mover.final;
        mover.phase = 'drop';
        return;
    }
    cancelMove();
}

function install() {
    const frame = require('./frame');
    onAfterFrame._tasName = 'ball.move';
    frame.onAfterFrame(onAfterFrame, 'level');
}

function stop() {
    const rb = rigidBody();
    if (rb === null) return false;
    bumpRevision(rb);
    zeroVelocity(rb);
    mem.writeVec3(rb.add(RB.totalForce), 0, 0, 0);
    mem.writeVec3(rb.add(RB.totalTorque), 0, 0, 0);
    activate(rb);
    return true;
}

// Same remove/add ResetPlayer uses. Rebuilds the broadphase proxy after a
// teleport so the ball does not fall through static geometry.
function relinkModel(model) {
    const phys = physics();
    if (phys === null || model === null || model === undefined) return false;
    const rb = model.add(ivar('rigidBody')).readPointer();
    if (rb.isNull()) return false;
    const node = new ObjC.Object(model);
    const handle = rb.add(RB.broadphaseHandle).readPointer();
    if (!handle.isNull()) {
        try { phys.removeRigidBodyFromModel_(node); } catch (err) { /* already out */ }
    }
    try { phys.addRigidBodyFromModel_(node); } catch (err) { return false; }
    activate(rb);
    return true;
}

function place(model, x, y, z, options) {
    const opts = options || {};
    if (model === null || model === undefined) return false;
    const rb = model.add(ivar('rigidBody')).readPointer();
    if (rb.isNull()) return false;
    if (opts.tree !== 'raw') inflateToward(rb, destBox(x, y, z));
    placeBody(rb, model, x, y, z, opts.keepVelocity);
    if (typeof opts.vy === 'number') {
        mem.writeVec3(rb.add(RB.linearVelocity), 0, opts.vy, 0);
    }
    return true;
}

module.exports = {
    levelLoaded, model, rigidBody, transform,
    initialTransform, initialPosition, spawnPosition, setInitialPosition,
    position, physicsPosition, velocity, angularVelocity, speed,
    teleport, nudge, slideTo, followPath, cancelMove, moving, install,
    aabb, aabbOf, inflateToward, radius, place, relinkModel, SAFE_SLIDE_Y,
    stop, activate, bumpRevision, zeroVelocity, scrubNaN, physics,
    skinIndex: () => mem.global('ballIndex').readS32(),
    skinCount: () => mem.global('ballCount').readS32(),
};
