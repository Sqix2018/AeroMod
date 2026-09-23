// Save states.
//
// Snapshots the ball's Bullet body plus the camera yaw and run timer. This does
// NOT rewind moving platforms, jump pads or animated scenery - those live in
// per-node animation times spread across the scene graph. Treat these as a
// routing/practice tool rather than a frame-perfect rewind.

const mem = require('../core/mem');
const ivars = require('../core/ivars');
const ball = require('../game/ball');

const RB = mem.RB;
const TF = mem.TF;

// Contiguous spans of btRigidBody that actually change during simulation.
const REGIONS = [
    [RB.worldTransform, 0xa0],  // world + interpolation transforms, interpolation velocities
    [RB.activationState, 0x08], // activation state + deactivation time
    [RB.linearVelocity, 0x20],  // linear + angular velocity
    [RB.totalForce, 0x20],      // accumulated force + torque
];

const SLOT_COUNT = 8;
const slots = new Array(SLOT_COUNT).fill(null);

function save(index) {
    const model = ball.model();
    if (model === null) return false;
    const rb = model.add(ivars.offsetOf('synNode', 'rigidBody')).readPointer();
    if (rb.isNull()) return false;

    const body = REGIONS.map(([offset, size]) => rb.add(offset).readByteArray(size));

    const transformPtr = model.add(ivars.offsetOf('synNode', 'worldTransform')).readPointer();
    const render = transformPtr.isNull() ? null : transformPtr.readByteArray(TF.size);

    const position = mem.readVec3(rb.add(RB.origin));

    slots[index] = {
        body, render, position,
        cameraYaw: mem.global('cameraYaw').readFloat(),
        runTimer: mem.global('runTimer').readFloat(),
        skin: mem.global('ballIndex').readS32(),
        savedAt: Date.now(),
    };
    return true;
}

function load(index) {
    const snapshot = slots[index];
    if (snapshot === null || snapshot === undefined) return false;

    const model = ball.model();
    if (model === null) return false;
    const rb = model.add(ivars.offsetOf('synNode', 'rigidBody')).readPointer();
    if (rb.isNull()) return false;

    ball.bumpRevision(rb);
    REGIONS.forEach(([offset], i) => rb.add(offset).writeByteArray(snapshot.body[i]));

    if (snapshot.render !== null) {
        const transformPtr = model.add(ivars.offsetOf('synNode', 'worldTransform')).readPointer();
        if (!transformPtr.isNull()) transformPtr.writeByteArray(snapshot.render);
    }

    // Keep the motion state in sync so the camera does not lerp from the old spot.
    const motionState = rb.add(RB.motionState).readPointer();
    if (!motionState.isNull()) {
        const p = snapshot.position;
        mem.writeVec3(motionState.add(RB.worldTransform + TF.origin), p.x, p.y, p.z);
    }

    mem.global('cameraYaw').writeFloat(snapshot.cameraYaw);
    mem.global('runTimer').writeFloat(snapshot.runTimer);

    ball.activate(rb);
    return true;
}

function has(index) {
    return slots[index] !== null && slots[index] !== undefined;
}

function describe(index) {
    const s = slots[index];
    if (s === null || s === undefined) return 'empty';
    return `${s.runTimer.toFixed(2)}s  ${s.position.x.toFixed(1)}, ` +
           `${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)}`;
}

function clear(index) { slots[index] = null; }
function clearAll() { slots.fill(null); }

module.exports = { SLOT_COUNT, save, load, has, describe, clear, clearAll, slots };
