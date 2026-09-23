// Read-only access to the loaded level's objects.
//
// synScene exposes `numModels` and a `sceneModels` array of synModel*, and every
// synNode carries the name it was authored with. The gameplay triggers are all
// found by name at runtime by the game itself, so the same names identify them
// here: StartPoint, CheckPointNN, EndFlare, ResetPlayer, Floor, SuckIn*,
// Bumper*, SpeedBoost*, JumpPad, SmashTrigger*, TextTriggerNN.

const mem = require('../core/mem');
const ivars = require('../core/ivars');

const TF = mem.TF;

function scene() {
    const p = mem.global('scene').readPointer();
    return p.isNull() ? null : new ObjC.Object(p);
}

function modelCount() {
    const s = scene();
    if (s === null) return 0;
    try { return s.numModels(); } catch (err) { return 0; }
}

function modelAt(index) {
    const s = scene();
    if (s === null) return null;
    const array = s.sceneModels();
    if (array === null || array.isNull()) return null;
    const p = array.add(index * Process.pointerSize).readPointer();
    return p.isNull() ? null : p;
}

// -[synNode name] is declared `char *`, and Frida's ObjC bridge turns a char*
// return into a JS string rather than a NativePointer. Treating it as a pointer
// throws, and because the caller is a UI refresh whose errors are swallowed,
// the whole tab silently stops updating - so handle both shapes.
function nameOf(modelPtr) {
    const raw = new ObjC.Object(modelPtr).name();
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw;
    const p = raw.handle === undefined ? raw : raw.handle;
    return p.isNull() ? '' : p.readUtf8String();
}

function transformOf(modelPtr) {
    const t = new ObjC.Object(modelPtr).worldTransform();
    if (t === null || t === undefined) return null;
    const p = t.handle === undefined ? t : t.handle;
    return (p instanceof NativePointer && !p.isNull()) ? p : null;
}

function positionOf(modelPtr) {
    const t = transformOf(modelPtr);
    return t === null ? null : mem.readVec3(t.add(TF.origin));
}

function radiusOf(modelPtr) {
    try { return new ObjC.Object(modelPtr).bSphereRadius(); } catch (err) { return 0; }
}

function rigidBodyTypeOf(modelPtr) {
    try { return new ObjC.Object(modelPtr).rigidBodyType(); } catch (err) { return 0; }
}

function rigidBodyOf(modelPtr) {
    if (modelPtr === null) return null;
    try {
        const rb = modelPtr.add(ivars.offsetOf('synNode', 'rigidBody')).readPointer();
        return rb.isNull() ? null : rb;
    } catch (err) {
        return null;
    }
}

// The Floor branch uses inverseMass > 0 to decide a body is movable. Same test.
function inverseMassOf(modelPtr) {
    const rb = rigidBodyOf(modelPtr);
    if (rb === null) return 0;
    try { return rb.add(mem.RB.inverseMass).readFloat(); } catch (err) { return 0; }
}

function physicsPositionOf(modelPtr) {
    const rb = rigidBodyOf(modelPtr);
    if (rb === null) return positionOf(modelPtr);
    try { return mem.readVec3(rb.add(mem.RB.origin)); } catch (err) {
        return positionOf(modelPtr);
    }
}

const dynCache = { key: null, items: null };
const trackCache = { key: null, items: null };

function sceneKey() {
    const p = mem.global('scene').readPointer();
    return p.isNull() ? null : p.toString();
}

// Scene pointer plus model count and first/last model: a scene reloaded at the
// old address gets a different key, so the caches never return freed models.
function sceneFullKey(key) {
    const n = modelCount();
    return `${key}/${n}/${n ? modelAt(0) : 0}/${n ? modelAt(n - 1) : 0}`;
}

function invalidateDynamics() {
    dynCache.key = null;
    dynCache.items = null;
    trackCache.key = null;
    trackCache.items = null;
}

// Every authored object with mass, except the ball. Scanned once per scene;
// live positions are read with physicsPositionOf when something actually needs
// them. Walking every model and calling name() on each is what made the WARP
// tab stall the game.
function dynamics() {
    const key = sceneKey();
    if (key === null) {
        invalidateDynamics();
        return [];
    }
    const fullKey = sceneFullKey(key);
    if (dynCache.key === fullKey && dynCache.items !== null) return dynCache.items;

    const ballPtr = mem.global('ball').readPointer();
    const out = [];
    const count = modelCount();
    for (let i = 0; i < count; i++) {
        const m = modelAt(i);
        if (m === null) continue;
        if (!ballPtr.isNull() && m.equals(ballPtr)) continue;
        const inv = inverseMassOf(m);
        if (!(inv > 0)) continue;
        out.push({
            index: i,
            name: nameOf(m),
            model: m,
            inverseMass: inv,
        });
    }
    dynCache.key = fullKey;
    dynCache.items = out;
    return out;
}

// Bodies whose pose actually changes: the ball, anything with mass, kinematic
// platforms, and vertex-animated meshes. Static floors stay out so rewind
// does not copy the whole scene every frame.
function trackable() {
    const key = sceneKey();
    if (key === null) {
        invalidateDynamics();
        return [];
    }
    // A reloaded scene can land at the old scene's address. Key on the model
    // array too, or the cache hands back freed models (crashed AUTO reloads).
    const fullKey = sceneFullKey(key);
    if (trackCache.key === fullKey && trackCache.items !== null) return trackCache.items;

    const ballPtr = mem.global('ball').readPointer();
    const out = [];
    const count = modelCount();
    for (let i = 0; i < count; i++) {
        const m = modelAt(i);
        if (m === null) continue;
        const rb = rigidBodyOf(m);
        let keep = false;
        if (!ballPtr.isNull() && m.equals(ballPtr)) keep = true;
        else if (rb !== null) {
            const inv = inverseMassOf(m);
            if (inv > 0) keep = true;
            else {
                try {
                    const flags = rb.add(mem.RB.collisionFlags).readS32();
                    if ((flags & 2) !== 0) keep = true;
                } catch (err) { /* */ }
            }
        }
        if (!keep) {
            try {
                const n = Number(new ObjC.Object(m).numVertexAnimFrames());
                if (n > 1) keep = true;
            } catch (err) { /* */ }
        }
        if (!keep) continue;
        out.push({
            index: i,
            name: nameOf(m),
            model: m,
        });
    }
    trackCache.key = fullKey;
    trackCache.items = out;
    return out;
}

// The game's own lookup. The bool is "exact": 0 means the name only has to
// contain the needle, which is how loadLevel: finds most authored objects.
function indexOfName(needle, exact) {
    const s = scene();
    if (s === null) return -1;
    try {
        const idx = s['getModelIndexFromName::'](needle, exact ? 1 : 0);
        return (typeof idx === 'number' && idx >= 0) ? idx : -1;
    } catch (err) {
        try {
            const idx = s.getModelIndexFromName__(needle, exact ? 1 : 0);
            return (typeof idx === 'number' && idx >= 0) ? idx : -1;
        } catch (err2) {
            return -1;
        }
    }
}

// Every model whose name contains `needle`, cheapest first: name, then geometry.
function find(needle, options) {
    const opts = options || {};
    const exact = opts.exact === true;
    const count = modelCount();
    const out = [];

    for (let i = 0; i < count; i++) {
        const m = modelAt(i);
        if (m === null) continue;
        const name = nameOf(m);
        if (exact ? name !== needle : name.indexOf(needle) === -1) continue;
        out.push({
            index: i,
            name,
            model: m,
            position: positionOf(m),
            radius: radiusOf(m),
            bodyType: rigidBodyTypeOf(m),
        });
    }
    return out;
}

function findOne(needle, options) {
    const all = find(needle, options);
    return all.length === 0 ? null : all[0];
}

// Name and position of everything in the level, for figuring out a new map.
function dump(filter) {
    const count = modelCount();
    const out = [];
    for (let i = 0; i < count; i++) {
        const m = modelAt(i);
        if (m === null) continue;
        const name = nameOf(m);
        if (filter !== undefined && name.indexOf(filter) === -1) continue;
        const p = positionOf(m);
        out.push({
            index: i, name, position: p,
            radius: radiusOf(m), bodyType: rigidBodyTypeOf(m),
        });
    }
    return out;
}

// Only objects the physics world actually knows about. The ocean floor has to
// be in this list or it could not kill you.
function dumpPhysics() {
    return dump().filter(m => m.bodyType);
}

// Lowest objects in the level - the kill volume sits under everything else.
function lowest(count) {
    const n = count === undefined ? 12 : count;
    return dump().filter(m => m.position !== null)
        .sort((a, b) => a.position.y - b.position.y)
        .slice(0, n);
}

function near(position, radius) {
    if (position === null) return [];
    const r2 = radius * radius;
    return dump().filter(m => {
        if (m.position === null) return false;
        const dx = m.position.x - position.x;
        const dy = m.position.y - position.y;
        const dz = m.position.z - position.z;
        return dx * dx + dy * dy + dz * dz <= r2;
    });
}

module.exports = {
    scene, modelCount, modelAt, nameOf, transformOf, positionOf, radiusOf,
    rigidBodyTypeOf, rigidBodyOf, inverseMassOf, physicsPositionOf, dynamics,
    trackable, invalidateDynamics,
    indexOfName, find, findOne, dump, dumpPhysics, lowest, near,
};
