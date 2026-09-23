// The level's footprint on the ground plane.
//
// Y is up in Aerox - the StartPoint check compares transform origins on Y to
// decide whether the ball is above the pad - so a plan view is XZ.
//
// Walking every model to find the extents is not cheap, but a level's geometry
// does not move between loads, so this is done once per scene and shared by the
// warp map and the coordinate picker.

const mem = require('../core/mem');
const scene = require('./scene');

const cache = { key: null, value: null };

function bounds() {
    const p = mem.global('scene').readPointer();
    if (p.isNull()) { cache.key = null; return null; }

    const key = p.toString();
    if (cache.key === key) return cache.value;

    const models = scene.dump();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    models.forEach(m => {
        if (m.position === null) return;
        if (m.position.x < minX) minX = m.position.x;
        if (m.position.x > maxX) maxX = m.position.x;
        if (m.position.z < minZ) minZ = m.position.z;
        if (m.position.z > maxZ) maxZ = m.position.z;
        if (m.position.y < minY) minY = m.position.y;
        if (m.position.y > maxY) maxY = m.position.y;
    });

    if (!isFinite(minX) || !isFinite(minZ)) {
        cache.key = key;
        cache.value = null;
        return null;
    }

    // Square the footprint so a plan view does not shear directions, and leave a
    // margin so geometry on the edge is not drawn against the frame.
    const span = Math.max(maxX - minX, maxZ - minZ, 1) * 1.08;
    const centreX = (minX + maxX) / 2;
    const centreZ = (minZ + maxZ) / 2;

    cache.key = key;
    cache.value = {
        minX: centreX - span / 2,
        minZ: centreZ - span / 2,
        span, centreX, centreZ,
        rawMinX: minX, rawMaxX: maxX,
        rawMinZ: minZ, rawMaxZ: maxZ,
        minY, maxY,
        models,
    };
    return cache.value;
}

// A projector fitting the level into a `size` x `size` box with `pad` margin.
function projector(size, pad) {
    const b = bounds();
    if (b === null) return null;

    const scale = (size - pad * 2) / b.span;
    return {
        bounds: b,
        scale,
        toScreen(position) {
            return {
                x: pad + (position.x - b.minX) * scale,
                y: pad + (position.z - b.minZ) * scale,
            };
        },
        toWorld(point) {
            return {
                x: b.minX + (point.x - pad) / scale,
                z: b.minZ + (point.y - pad) / scale,
            };
        },
    };
}

module.exports = { bounds, projector };
