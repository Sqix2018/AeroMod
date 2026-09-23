// Module base resolution, the active offset layout, and small memory helpers.

const offsets = require('./offsets');

const module_ = Process.findModuleByName('Aerox') || Process.enumerateModules()[0];
const resolved = offsets.resolve();

const G = resolved.layout.globals;
const FN = resolved.layout.functions;
const RB = offsets.RIGID_BODY;
const TF = offsets.TRANSFORM;
const PROXY = offsets.BROADPHASE_PROXY;

// Absolute address of a named global from the active layout.
function global_(name) {
    const rva = G[name];
    if (rva === undefined) throw new Error(`unknown global: ${name}`);
    return module_.base.add(rva);
}

function fn(name) {
    const rva = FN[name];
    if (rva === undefined) throw new Error(`unknown function: ${name}`);
    return module_.base.add(rva);
}

// Frida 17 removed Module.findExportByName. Look up a system symbol without
// calling the old static method.
function findExport(moduleName, exportName) {
    const ok = (p) => (p !== null && p !== undefined && !p.isNull()) ? p : null;
    try {
        if (!moduleName) {
            if (typeof Module.findGlobalExportByName === 'function') {
                const p = ok(Module.findGlobalExportByName(exportName));
                if (p !== null) return p;
            }
            if (typeof Module.getGlobalExportByName === 'function') {
                try {
                    const p = ok(Module.getGlobalExportByName(exportName));
                    if (p !== null) return p;
                } catch (err) { /* missing */ }
            }
            return null;
        }
        const mod = Process.findModuleByName(moduleName);
        if (mod === null) return null;
        if (typeof mod.findExportByName === 'function') {
            const p = ok(mod.findExportByName(exportName));
            if (p !== null) return p;
        }
        if (typeof mod.getExportByName === 'function') {
            try {
                const p = ok(mod.getExportByName(exportName));
                if (p !== null) return p;
            } catch (err) { /* missing */ }
        }
    } catch (err) { /* */ }
    return null;
}

function readVec3(ptr) {
    return { x: ptr.readFloat(), y: ptr.add(4).readFloat(), z: ptr.add(8).readFloat() };
}

function writeVec3(ptr, x, y, z) {
    ptr.writeFloat(x);
    ptr.add(4).writeFloat(y);
    ptr.add(8).writeFloat(z);
}

function length3(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
}

function sub3(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function scale3(v, s) {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function finite3(v) {
    return v !== null && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
}

function aabbOverlap(a, b) {
    if (a === null || b === null) return false;
    return a.min.x <= b.max.x && a.max.x >= b.min.x
        && a.min.y <= b.max.y && a.max.y >= b.min.y
        && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function aabbUnion(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    return {
        min: {
            x: Math.min(a.min.x, b.min.x),
            y: Math.min(a.min.y, b.min.y),
            z: Math.min(a.min.z, b.min.z),
        },
        max: {
            x: Math.max(a.max.x, b.max.x),
            y: Math.max(a.max.y, b.max.y),
            z: Math.max(a.max.z, b.max.z),
        },
    };
}

function aabbAround(center, radius) {
    return {
        min: { x: center.x - radius, y: center.y - radius, z: center.z - radius },
        max: { x: center.x + radius, y: center.y + radius, z: center.z + radius },
    };
}

// Signed gap between two boxes. Negative means they overlap (the tightest axis).
function aabbGap(a, b) {
    if (a === null || b === null) return null;
    const dx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x);
    const dy = Math.max(a.min.y - b.max.y, b.min.y - a.max.y);
    const dz = Math.max(a.min.z - b.max.z, b.min.z - a.max.z);
    if (dx <= 0 && dy <= 0 && dz <= 0) return Math.max(dx, dy, dz);
    const ex = Math.max(dx, 0);
    const ey = Math.max(dy, 0);
    const ez = Math.max(dz, 0);
    return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

function fmtAabb(box) {
    if (box === null) return 'null';
    return `${box.min.x.toFixed(1)},${box.min.y.toFixed(1)},${box.min.z.toFixed(1)}`
        + ` .. ${box.max.x.toFixed(1)},${box.max.y.toFixed(1)},${box.max.z.toFixed(1)}`;
}

// The game normalises the ball's linear velocity in several places without
// guarding against a zero-length vector, so an exactly-zero velocity produces
// 1/0 -> Inf -> NaN and poisons the transform and the camera yaw for good.
// Anywhere we would write a zero velocity we write this instead.
const VELOCITY_EPSILON = 1e-4;

// Autorelease pools. ObjC calls made off the main run loop (Frida timers run
// on the JS thread) have no pool to drain, so every autoreleased object they
// return - NSStrings, arrays, wrappers - is kept forever. Anything that can
// run from a timer wraps its ObjC work in withPool.
let poolPushFn = null;
let poolPopFn = null;

function poolPush() {
    if (poolPushFn === null) {
        try {
            poolPushFn = new NativeFunction(findExport(null, 'objc_autoreleasePoolPush'), 'pointer', []);
            poolPopFn = new NativeFunction(findExport(null, 'objc_autoreleasePoolPop'), 'void', ['pointer']);
        } catch (err) {
            poolPushFn = false;
        }
    }
    return poolPushFn ? poolPushFn() : null;
}

function poolPop(token) {
    if (token !== null && poolPopFn) poolPopFn(token);
}

function withPool(fn) {
    const token = poolPush();
    try { return fn(); } finally { poolPop(token); }
}

module.exports = {
    module: module_,
    base: module_.base,
    version: resolved.version,
    exactVersion: resolved.exact,
    G, FN, RB, TF, PROXY,
    VELOCITY_EPSILON,
    global: global_, fn, findExport,
    poolPush, poolPop, withPool,
    readVec3, writeVec3, length3, clamp,
    sub3, dot3, scale3, finite3,
    aabbOverlap, aabbUnion, aabbAround, aabbGap, fmtAabb,
};
