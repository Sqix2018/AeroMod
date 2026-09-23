// World-to-screen projection using the game's own active camera.
//
// synCamera is a synNode, so it carries a btTransform, and it exposes fov,
// aspectRatio, zNear and zFar directly. That is everything needed to rebuild the
// view-projection by hand and put 2D markers over the 3D scene.
//
// btMatrix3x3 stores three rows of btVector3, 16 bytes each. The basis maps
// local to world, so the camera's world axes are its *columns*, and transforming
// a world point into view space is a dot product against each column.
//
// Orientation conventions are the one thing that cannot be read out of the
// binary: whether fov is stored in degrees or radians, and how the GL viewport
// maps onto UIKit's coordinate space in landscape. Both are handled by
// `orientation` below, which is exposed in the panel - the ball marker doubles
// as an alignment reference, so if the overlay is mirrored it is obvious and
// one toggle fixes it.

const mem = require('../core/mem');

const TF = mem.TF;

// Adjustable because the GL viewport / UIKit mapping cannot be derived statically.
const orientation = {
    flipX: false,
    flipY: false,
    swapAxes: false,
};

function activeCamera() {
    const scenePtr = mem.global('scene').readPointer();
    if (scenePtr.isNull()) return null;
    const cam = new ObjC.Object(scenePtr).activeCamera();
    if (cam === null || cam.isNull()) return null;
    return cam;
}

function transformOf(node) {
    const t = node.worldTransform();
    if (t === null || t === undefined) return null;
    const p = t.handle === undefined ? t : t.handle;
    return (p instanceof NativePointer && !p.isNull()) ? p : null;
}

// Everything the projection needs, read once per frame rather than per point.
function snapshot(viewSize) {
    const cam = activeCamera();
    if (cam === null) return null;

    const tf = transformOf(cam);
    if (tf === null) return null;

    let isOrtho = false;
    try { isOrtho = cam.isOrthographic(); } catch (err) { isOrtho = false; }
    if (isOrtho) return null; // gameplay camera is perspective; skip menus

    const origin = mem.readVec3(tf.add(TF.origin));

    // Rows of btMatrix3x3, then the columns we actually want.
    const row = i => mem.readVec3(tf.add(i * 16));
    const r0 = row(0);
    const r1 = row(1);
    const r2 = row(2);

    const right = { x: r0.x, y: r1.x, z: r2.x };
    const up = { x: r0.y, y: r1.y, z: r2.y };
    const back = { x: r0.z, y: r1.z, z: r2.z }; // camera looks along -back

    let fov = cam.fov();
    if (!isFinite(fov) || fov <= 0) return null;
    // A vertical fov above ~3.2 cannot be radians for any sane camera.
    if (fov > 3.2) fov = fov * Math.PI / 180;

    let aspect = cam.aspectRatio();
    if (!isFinite(aspect) || aspect <= 0) {
        aspect = viewSize.width / Math.max(viewSize.height, 1);
    }

    let near = 0.1;
    try { near = cam.zNear(); } catch (err) { near = 0.1; }
    if (!isFinite(near) || near <= 0) near = 0.1;

    return {
        origin, right, up, back,
        focal: 1 / Math.tan(fov / 2),
        aspect, near,
        width: viewSize.width,
        height: viewSize.height,
    };
}

// World point -> screen point, or null when behind the camera.
function project(point, cam) {
    const d = mem.sub3(point, cam.origin);

    const depth = -mem.dot3(d, cam.back);
    if (depth <= cam.near) return null;

    let ndcX = (mem.dot3(d, cam.right) * cam.focal / cam.aspect) / depth;
    let ndcY = (mem.dot3(d, cam.up) * cam.focal) / depth;

    if (orientation.swapAxes) { const t = ndcX; ndcX = ndcY; ndcY = t; }
    if (orientation.flipX) ndcX = -ndcX;
    if (orientation.flipY) ndcY = -ndcY;

    return {
        x: (ndcX + 1) * 0.5 * cam.width,
        y: (1 - ndcY) * 0.5 * cam.height,
        depth,
    };
}

// PLAY-only visual orbit. processGameFrame rebuilds the camera from cameraYaw
// each tick, so rotating the node after physics and restoring it after the
// draw cannot change the recorded line.
let visualHold = null;

function readXf(tf) {
    return {
        r0: mem.readVec3(tf),
        r1: mem.readVec3(tf.add(16)),
        r2: mem.readVec3(tf.add(32)),
        o: mem.readVec3(tf.add(TF.origin)),
    };
}

function writeXf(tf, xf) {
    mem.writeVec3(tf, xf.r0.x, xf.r0.y, xf.r0.z);
    mem.writeVec3(tf.add(16), xf.r1.x, xf.r1.y, xf.r1.z);
    mem.writeVec3(tf.add(32), xf.r2.x, xf.r2.y, xf.r2.z);
    mem.writeVec3(tf.add(TF.origin), xf.o.x, xf.o.y, xf.o.z);
}

function rotY(v, c, s) {
    return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

function restoreVisual() {
    if (visualHold === null) return;
    const hold = visualHold;
    visualHold = null;
    try {
        const cam = activeCamera();
        if (cam === null) return;
        const tf = transformOf(cam);
        if (tf === null) return;
        if (typeof tf.compare === 'function' && tf.compare(hold.tf) !== 0) return;
        writeXf(tf, hold.xf);
    } catch (err) { /* scene gone */ }
}

function applyVisualYaw(delta) {
    restoreVisual();
    if (!isFinite(delta) || Math.abs(delta) < 1e-4) return false;
    const cam = activeCamera();
    if (cam === null) return false;
    const tf = transformOf(cam);
    if (tf === null) return false;
    const xf = readXf(tf);
    if (!mem.finite3(xf.o)) return false;
    let pivot = xf.o;
    try {
        const p = require('./ball').position();
        if (p && mem.finite3(p)) pivot = p;
    } catch (err) { /* */ }
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    const rel = rotY({ x: xf.o.x - pivot.x, y: 0, z: xf.o.z - pivot.z }, c, s);
    visualHold = { tf, xf };
    writeXf(tf, {
        r0: rotY(xf.r0, c, s),
        r1: rotY(xf.r1, c, s),
        r2: rotY(xf.r2, c, s),
        o: { x: pivot.x + rel.x, y: xf.o.y, z: pivot.z + rel.z },
    });
    return true;
}

module.exports = {
    orientation, activeCamera, snapshot, project,
    applyVisualYaw, restoreVisual,
};
