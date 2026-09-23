// Death warp: what is established, what is not, and how to gather more.
//
// ---------------------------------------------------------------- the cause
//
// Every gameplay trigger in Aerox lives in one function, the Bullet broadphase
// filter callback. It runs the stock group/mask test, then switches on the other
// object's authored name and runs the reaction inline. The finish, EndFlare, is
// guarded by one thing: whether the level is already complete. No in-play check,
// no position check, no narrowphase contact test. Broadphase pairing with
// EndFlare *is* winning.
//
// The reset does removeRigidBody -> overwrite the world transform with the
// ball's initialWorldTransform -> zero velocities -> addRigidBody, all from
// inside that same callback, so it mutates the broadphase while Bullet is
// iterating it. That much is solid and explains why a death can complete a level.
//
// ------------------------------------------------- what the level 9 data kills
//
// The model I built on top of that - "the segment from where you died to where
// you respawn passes through the finish" - is wrong, and level 9 disproves it
// outright:
//
//     spawn   96.00,   9.70, 34.00
//     finish  -4.00,  20.10, 64.00
//
// The finish is ABOVE the spawn, so the ray rises as it leaves the finish and
// keeps rising forever. It never comes back down. Yet two confirmed warps were
// triggered at y = -21.58 and y = -22.11, roughly 30 units below the spawn and
// 42 below the finish. In 3D those points miss the finish by 31.6 and 24.8 units.
// No amount of tolerance closes that.
//
// One thing did survive. Projected onto the ground plane the same two deaths
// miss by 12.4 and 10.0, and the X coordinate of closest approach lands at -6.1
// and -5.9 against a finish X of -4.0. Two points is not a model, but a
// consistent near-miss in XZ with a large and varying miss in Y is what you
// would expect if the test that matters is effectively horizontal - if the
// objects involved have tall broadphase boxes, or if height simply is not part
// of whatever is going wrong. So the tool still draws the XZ ray, clearly
// labelled as a hypothesis rather than an answer.
//
// The smear was a false lead: inflate-teleport made the ball box span the
// whole map. The real mutation on 9 and 11 is a *different* dynamic body
// hitting Floor. Floor does removeRigidBody on any inverseMass>0 object
// (and hides it unless the name contains Respawn). That mid-iteration remove
// is what rearranges the tree; the ball's first death afterwards can pair
// EndFlare. Touching the barrels is not enough. A death that is not first
// after the void spends the arm. Checkpoint order is still being mapped.
//
// ------------------------------------------------------------ so: measurement
//
// Rather than ship another guess, tas/warplog.js records every death and marks
// whether it warped, and the map draws them. The kill height is measured from
// those deaths instead of being looked up by model name, which is also the fix
// for level 9 reporting "no ResetPlayer or Floor volume found" - that level
// simply does not use those names.

const mem = require('../core/mem');
const log = require('../core/log');
const ball = require('../game/ball');
const scene = require('../game/scene');
const frame = require('../game/frame');
const level = require('../game/level');
const extents = require('../game/extents');
const warplog = require('./warplog');

const DEFAULT_FINISH_RADIUS = 2.5;
const TEST_DROP_HEIGHT = 6;
const VOID_DROP_Y = -22;
const VOID_OBJECT_Y = 4;
const VOID_FALL_V = -18;

// Measured warps. Level 9: after a barrel hits Floor. Level 11: after a
// checkpoint, then the one movable hits the void.
const KNOWN = {
    9: {
        object: {
            name: 'Barrel',
            spawn: { x: 92.65, y: 17.00, z: -62.22 },
            voidAt: { x: 112.0, y: 4.0, z: -64.0 },
        },
        // CP off, start spawn 96, 9.69, 34. After a Barrel Floor hit, first
        // death warps in the NW ocean: x <= -40 and z >= 80, out to about
        // x = -240, z = 240 on a 40-unit grid. Interior holes in that run:
        // (-40, 160) and (-120, 240) died without warping. South of z = 40
        // and east of x = 0 were all regular deaths.
        region: {
            minX: -240, maxX: -40, minZ: 80, maxZ: 240,
            holes: [
                { x: -40, z: 160 },
                { x: -120, z: 240 },
            ],
        },
        spots: [
            {
                death: { x: -160.00, y: -22.72, z: 88.00 },
                spawn: { x: 96.00, y: 9.69, z: 34.00 },
                note: 'start spawn, after barrel void',
            },
            {
                death: { x: -157.16, y: -22.59, z: 95.37 },
                spawn: { x: 96.00, y: 9.69, z: 34.00 },
                note: 'start spawn, second hit',
            },
        ],
    },
    11: {
        object: {
            name: 'CrateBigger01',
            spawn: { x: 9.58, y: 12.97, z: 111.40 },
            voidAt: { x: 37.55, y: -0.23, z: 128.86 },
        },
        spots: [
            {
                death: { x: 96.28, y: -22.56, z: -77.77 },
                spawn: { x: -64.00, y: 16.02, z: 8.00 },
                note: 'checkpoint spawn',
            },
            {
                death: { x: 106.98, y: -22.39, z: -65.85 },
                spawn: { x: -64.00, y: 16.02, z: 8.00 },
                note: 'checkpoint spawn, second hit',
            },
        ],
    },
};

const cursor = { warp: 0, movable: 0, probe: 0, probeOn: 0, probeOff: 0 };

// Names worth checking for a kill volume. Level 9 matches none of them, which is
// why the measured height from warplog is the primary source now.
const KILL_NAMES = ['ResetPlayer', 'Floor', 'Water', 'Ocean', 'Kill', 'Death',
    'Respawn', 'Reset', 'Bounds', 'OutOfBounds', 'Void'];

const state = {
    watching: true,
    lastComplete: false,
    events: [],
    originalSpawn: null,
    closestFinish: null,
    focus: null,
    wantCheckpoint: false,
    appliedThisLoad: false,
    objectDropY: 4,
    lastProbe: null,
};

const loadWatch = { started: false, intro: false, level: null };

const autoVoid = {
    on: false,
    phase: 'idle',
    wait: 0,
    dropTry: 0,
    deathMark: 0,
};


const cache = { key: null, finish: null, kill: null, lowest: [], base: null, cpKey: null, cps: [] };

function sceneKey() {
    const p = mem.global('scene').readPointer();
    return p.isNull() ? null : p.toString();
}

function refreshCache() {
    const key = sceneKey();
    const n = level.levelNumber();
    const cacheKey = `${key}:${n}`;
    if (key === null) { cache.key = null; return false; }
    if (cache.key === cacheKey) return true;

    const f = scene.findOne('EndFlare', { exact: true })
        || scene.findOne('EndFlare');
    cache.finish = (f === null || f.position === null) ? null : {
        position: f.position,
        radius: f.radius > 0 ? f.radius : DEFAULT_FINISH_RADIUS,
    };

    cache.kill = null;
    cache.lowest = [];
    cache.base = cache.finish === null ? null : {
        x: cache.finish.position.x,
        y: cache.finish.position.y - cache.finish.radius,
        z: cache.finish.position.z,
    };
    cache.key = cacheKey;

    const startObj = scene.findOne('StartPoint');
    state.originalSpawn = (startObj && startObj.position)
        ? startObj.position
        : ball.initialPosition();
    state.closestFinish = null;
    return true;
}

function isComplete() { return mem.global('levelComplete').readU8() !== 0; }
function finish() { return refreshCache() ? cache.finish : null; }
function respawn() { return ball.initialPosition(); }
function checkpoints() {
    const key = `${sceneKey()}:${level.levelNumber()}`;
    if (cache.cpKey === key && cache.cps) return cache.cps;
    cache.cpKey = key;
    cache.cps = scene.find('CheckPoint');
    return cache.cps;
}

function hasCheckpoints() {
    return checkpoints().some(c => c.position !== null);
}

function usingCheckpoint() {
    return state.wantCheckpoint && hasCheckpoints();
}

// Measured first, named second. Measurement is the only thing that worked on
// level 9, and it is the only thing that can be right on a level nobody has
// named-matched yet.
function killPlane() {
    const measured = warplog.measuredKillY();
    if (measured !== null) {
        return {
            y: measured.y,
            source: `measured from ${measured.samples} death(s)`,
            count: measured.samples,
            measured: true,
            low: measured.low,
            high: measured.high,
        };
    }
    refreshCache();
    return cache.kill === null ? null
        : { y: cache.kill.y, source: cache.kill.source, count: cache.kill.count,
            measured: false };
}

function finishBase() {
    return refreshCache() ? cache.base : null;
}

function corridor() {
    const f = finish();
    const r = respawn();
    if (f === null || r === null) return null;

    const base = finishBase();
    const away = mem.sub3(base, r);
    const span = mem.length3(away);
    if (span === 0) return null;

    // The ground-plane direction, which is the part the level 9 data still
    // supports. Kept separate from the 3D direction on purpose.
    const flatLength = Math.sqrt(away.x * away.x + away.z * away.z);

    return {
        respawn: r,
        finish: base,
        flare: f.position,
        radius: f.radius,
        direction: mem.scale3(away, 1 / span),
        flat: flatLength === 0 ? { x: 0, z: 0 }
            : { x: away.x / flatLength, z: away.z / flatLength },
        startDistance: span,
        rises: base.y > r.y,
    };
}

// Distance from a point to the ground-plane ray, and how far along it sits.
function flatMiss(point) {
    const c = corridor();
    if (c === null || point === null) return null;

    const dx = point.x - c.respawn.x;
    const dz = point.z - c.respawn.z;
    const along = dx * c.flat.x + dz * c.flat.z;
    const missX = dx - along * c.flat.x;
    const missZ = dz - along * c.flat.z;

    return {
        along,
        miss: Math.sqrt(missX * missX + missZ * missZ),
        pastFinish: along - Math.sqrt(
            Math.pow(c.finish.x - c.respawn.x, 2) + Math.pow(c.finish.z - c.respawn.z, 2)),
    };
}

// The XZ hypothesis, stated as a hypothesis. There is no 3D solve any more
// because level 9 showed there is nothing to solve.
function solve() {
    const c = corridor();
    if (c === null) {
        return { feasible: false, reason: finish() === null
            ? 'this level has no EndFlare' : 'no respawn point yet' };
    }

    const kill = killPlane();
    if (kill === null) {
        return {
            feasible: false,
            reason: 'kill height unknown - die once and it will be measured',
            corridor: c,
        };
    }

    // Walk the ground-plane ray out past the finish, sitting at the kill height.
    const flatToFinish = Math.sqrt(
        Math.pow(c.finish.x - c.respawn.x, 2) + Math.pow(c.finish.z - c.respawn.z, 2));

    return {
        feasible: true,
        hypothesis: true,
        reason: null,
        corridor: c,
        kill,
        flatToFinish,
        // Best guess at a spot to try: on the ray, past the finish, at kill height.
        point: {
            x: c.finish.x + c.flat.x * flatToFinish * 0.5,
            y: kill.y,
            z: c.finish.z + c.flat.z * flatToFinish * 0.5,
        },
        tolerance: Math.max(c.radius * 2, 8),
    };
}

function evaluate(position) {
    const p = position || ball.physicsPosition();
    const f = flatMiss(p);
    const kill = killPlane();
    const tree = warplog.treeHint();
    if (f === null && tree.flareAabb === null) return null;

    return {
        position: p,
        along: f === null ? 0 : f.along,
        pastFinish: f === null ? 0 : f.pastFinish,
        miss: f === null ? 0 : f.miss,
        killY: kill === null ? null : kill.y,
        nearPlane: kill === null ? false : Math.abs(p.y - kill.y) < 8,
        onLine: f !== null && f.miss < 12 && f.pastFinish > 0,
        smearGap: tree.smearGap,
        lastGap: tree.lastGap,
        closestSmear: tree.closestSmear,
        nearFlare: tree.nearFlare,
        voidArmed: tree.voidArmed,
        voidSpent: tree.voidSpent,
        movables: tree.movables,
    };
}

function describe() {
    if (!ball.levelLoaded()) return 'no level';

    const s = warplog.summary();
    const tree = warplog.treeHint();
    const counts = `${s.deaths} death(s), ${s.warps} warp(s)`;
    let arm;
    if (autoVoid.on && level.introPlaying()) {
        arm = 'waiting to skip intro - not armed yet';
    } else if (tree.voidArmed === null) {
        arm = tree.movables > 0
            ? `${tree.movables} movable(s) - knock one into the void`
            : 'no movables on this level';
    } else if (tree.voidSpent) {
        arm = `${tree.voidArmed.name} void spent (died after)`;
    } else {
        arm = `ARMED ${tree.voidArmed.name} - first death can warp`;
    }
    const cp = usingCheckpoint() ? 'CP on' : 'CP off';
    const extra = autoVoid.on ? `   AUTO VOID ${autoVoid.phase}` : '';
    return `${arm}\n${counts}   ${cp}${extra}`;
}

function levelIndex(n) {
    if (n !== undefined) return n;
    const live = level.levelNumber();
    if (level.inLevel() && !level.complete() && live >= 0) return live;
    return warplog.state.level !== null ? warplog.state.level : live;
}

function knownEntry(n) {
    return KNOWN[levelIndex(n)] || null;
}

function known(n) {
    const entry = knownEntry(n);
    if (entry === null || !entry.spots || entry.spots.length === 0) return null;
    return Object.assign({ object: entry.object || null }, entry.spots[0]);
}

function xzKey(p) {
    return `${Math.round(p.x)},${Math.round(p.z)}`;
}

function xzDist(a, b) {
    if (a === null || b === null) return null;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function dropAt(x, z) {
    return ball.teleport(x, VOID_DROP_Y, z, { tree: 'raw' });
}


const SKIP_RE = /chain/i;
const USEFUL_RE = /crate|barrel|keg|weight|target/i;
const BOX_RE = /crate|barrel|keg|weight|box/i;
const PLANK_RE = /plank/i;

function isPlankName(name) {
    return PLANK_RE.test(name || '');
}

function isBoxName(name) {
    const n = name || '';
    if (isPlankName(n)) return false;
    return BOX_RE.test(n);
}

function hasBoxPresent() {
    return warplog.state.movers.some(m => isBoxName(m.name));
}

function isUsefulName(name) {
    const n = name || '';
    if (SKIP_RE.test(n)) return false;
    // Planks arm warps but wreck the stage. AUTO VOID keeps them off
    // whenever a crate/barrel is present.
    if (isPlankName(n) && hasBoxPresent()) return false;
    const known = knownEntry();
    if (known && known.object && known.object.name) {
        return n.toLowerCase() === known.object.name.toLowerCase();
    }
    if (warplog.state.useful.indexOf(n) !== -1) return true;
    return USEFUL_RE.test(n);
}

function usefulTargets() {
    const known = knownEntry();
    if (known && known.object && known.object.name) {
        warplog.rememberUseful(known.object.name);
    }
    const all = warplog.state.movers.filter(m => isUsefulName(m.name));
    if (hasBoxPresent()) return all.filter(m => !isPlankName(m.name));
    return all;
}

function probeVoidTargets() {
    const primary = usefulTargets();
    const seen = {};
    primary.forEach(m => { seen[m.name] = true; });
    const rest = warplog.state.movers.filter(m => {
        const n = m.name || '';
        if (SKIP_RE.test(n) || seen[n]) return false;
        seen[n] = true;
        return true;
    });
    return primary.concat(rest);
}

function voidList(kind) {
    if (kind === 'other') return otherTargets();
    if (kind === 'probe') return probeVoidTargets();
    return usefulTargets();
}

function otherTargets() {
    return warplog.state.movers.filter(m => !isUsefulName(m.name));
}

function knockTargets() {
    return usefulTargets();
}

function goMovable() {
    const all = knockTargets();
    if (all.length === 0) return { ok: false, reason: 'no useful movables' };
    const i = ((cursor.movable % all.length) + all.length) % all.length;
    cursor.movable = i + 1;
    const m = all[i];
    const pos = m.last || scene.physicsPositionOf(m.model);
    if (pos === null) return { ok: false, reason: 'movable has no position' };
    state.focus = m;
    const ok = ball.slideTo(pos.x, pos.y + 4, pos.z, { step: 5 });
    return {
        ok, index: i, total: all.length, movable: m,
        label: `${m.name || '(unnamed)'} ${i + 1}/${all.length}`,
    };
}

function placeForeign(model, x, y, z) {
    return ball.place(model, x, y, z, { vy: VOID_FALL_V, tree: 'raw' });
}

const VOID_PADS = [12, 22, 36, 52];

function voidDropCandidates(pos) {
    const known = knownEntry();
    const y = state.objectDropY;
    if (known && known.object && known.object.voidAt) {
        const v = known.object.voidAt;
        return [{ x: v.x, y, z: v.z }];
    }
    const b = extents.bounds();
    if (b === null) {
        return pos === null ? [] : [{ x: pos.x, y, z: pos.z }];
    }
    const px = pos === null ? b.centreX : pos.x;
    const pz = pos === null ? b.centreZ : pos.z;
    const out = [];
    VOID_PADS.forEach(pad => {
        out.push({ x: b.rawMinX - pad, y, z: pz });
        out.push({ x: b.rawMaxX + pad, y, z: pz });
        out.push({ x: px, y, z: b.rawMinZ - pad });
        out.push({ x: px, y, z: b.rawMaxZ + pad });
    });
    return out;
}

function voidDropPoint(pos) {
    const all = voidDropCandidates(pos);
    if (all.length === 0) return pos === null ? null : { x: pos.x, y: state.objectDropY, z: pos.z };
    const n = autoVoid.dropTry;
    return all[((n % all.length) + all.length) % all.length];
}

function forceVoid(kind) {
    const list = voidList(kind);
    if (list.length === 0) {
        return {
            ok: false,
            reason: kind === 'other' ? 'no other movables'
                : kind === 'probe' ? 'no movables to void'
                : 'no primary void object',
        };
    }
    let m = state.focus;
    if (m === null || !list.some(x => x.model && m.model && x.model.equals(m.model))) {
        const i = ((cursor.movable % list.length) + list.length) % list.length;
        m = list[i];
        cursor.movable = i + 1;
    }
    const pos = m.last || scene.physicsPositionOf(m.model);
    if (pos === null) return { ok: false, reason: 'movable has no position' };
    const dest = voidDropPoint(pos);
    const ok = placeForeign(m.model, dest.x, dest.y, dest.z);
    if (ok) {
        state.focus = m;
        warplog.arm();
        log.info(`dropped ${m.name} toward the void at ${dest.x.toFixed(1)}, `
            + `${dest.y.toFixed(1)}, ${dest.z.toFixed(1)}`, 'warp');
    }
    return { ok, movable: m, label: m.name };
}

const WORLD = 240;

// Atlas "what to probe next": extra bias on top of behind-flare → large X.
// Checkpoint on/off are different half-planes.

function wrap180(d) {
    let x = d;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return x;
}

function hasIndependentCheckpoint() {
    const start = state.originalSpawn || warplog.state.levelSpawn;
    return checkpoints().some(c => c.position
        && (!start || xzDist(c.position, start) > 8));
}

function snapGrid(v, step) {
    return Math.round(v / step) * step;
}

function probeBounds() {
    const b = extents.bounds();
    const step = warplog.GRID;
    const pad = step * 2;
    let minX = -WORLD;
    let maxX = WORLD;
    let minZ = -WORLD;
    let maxZ = WORLD;
    if (b !== null) {
        minX = Math.min(minX, Math.floor((b.rawMinX - pad) / step) * step);
        maxX = Math.max(maxX, Math.ceil((b.rawMaxX + pad) / step) * step);
        minZ = Math.min(minZ, Math.floor((b.rawMinZ - pad) / step) * step);
        maxZ = Math.max(maxZ, Math.ceil((b.rawMaxZ + pad) / step) * step);
    }
    minX = Math.max(minX, -WORLD - step);
    maxX = Math.min(maxX, WORLD + step);
    minZ = Math.max(minZ, -WORLD - step);
    maxZ = Math.min(maxZ, WORLD + step);
    return { minX, maxX, minZ, maxZ, step };
}

function movables() {
    return scene.dynamics();
}

// ------------------------------------------------------------- test helpers

function aim() {
    const s = solve();
    if (!s.feasible) return false;
    return ball.teleport(s.point.x, s.point.y + TEST_DROP_HEIGHT, s.point.z);
}

// Put the ball on the ground-plane ray, `distance` units past the finish, at
// whatever height we believe deaths happen.
function aimAt(distance) {
    const c = corridor();
    if (c === null) return false;

    const kill = killPlane();
    const y = (kill === null ? c.finish.y : kill.y) + TEST_DROP_HEIGHT;
    return ball.teleport(
        c.finish.x + c.flat.x * distance,
        y,
        c.finish.z + c.flat.z * distance);
}

// Re-run a recorded death from its own approach path rather than from a
// teleport, since arriving under your own power is the one thing that has
// reliably reproduced the warp so far.
function replayHit(index) {
    const all = warplog.hits();
    if (index < 0 || index >= all.length) return false;
    const hit = all[index];
    const trail = (hit.trail !== undefined && hit.trail.length > 1) ? hit.trail : null;
    if (trail !== null) {
        log.info(`replaying death #${index} along ${trail.length} AABB steps`, 'warp');
        return ball.followPath(trail);
    }
    const start = hit.position;
    log.info(`replaying death #${index} from ${warplog.fmt(start)}`, 'warp');
    return ball.slideTo(start.x, start.y, start.z);
}

// ------------------------------------------------------------- checkpoints

function checkpointTaken() {
    const now = respawn();
    if (now === null || state.originalSpawn === null) return false;
    return mem.length3(mem.sub3(now, state.originalSpawn)) > 1;
}

function wantCheckpoint() {
    return state.wantCheckpoint;
}

function setWantCheckpoint(on) {
    state.wantCheckpoint = !!on;
    warplog.setCheckpointOverride(usingCheckpoint());
    if (!state.wantCheckpoint) {
        clearCheckpoint();
        state.appliedThisLoad = false;
        return false;
    }
    if (!hasCheckpoints()) {
        state.appliedThisLoad = true;
        log.info('no checkpoint on this level - CP on ignored', 'warp');
        return true;
    }
    if (warplog.state.levelSpawn !== null) {
        state.appliedThisLoad = applyCheckpoint(0);
    } else {
        state.appliedThisLoad = false;
    }
    return true;
}

function clearCheckpoint() {
    if (state.originalSpawn === null) return false;
    const ok = ball.setInitialPosition(
        state.originalSpawn.x, state.originalSpawn.y, state.originalSpawn.z);
    log.info(ok ? `spawn reset to ${warplog.fmt(state.originalSpawn)}`
        : 'could not reset spawn', 'warp');
    return ok;
}

// Approximate: the game lifts the ball slightly off the checkpoint transform by
// a constant we do not read, so this puts it a couple of units above instead.
function applyCheckpoint(index) {
    const all = checkpoints().filter(c => c.position !== null);
    if (all.length === 0) return false;
    const c = all[Math.min(Math.max(index || 0, 0), all.length - 1)];
    const ok = ball.setInitialPosition(c.position.x, c.position.y + 2, c.position.z);
    log.debug(ok ? `spawn moved to checkpoint ${index} ${warplog.fmt(c.position)}`
        : 'could not move spawn', 'warp');
    return ok;
}

function loggedLevel() {
    if (level.complete() && warplog.state.level !== null) return warplog.state.level;
    const n = level.levelNumber();
    return n >= 0 ? n : warplog.state.level;
}

// AUTO VOID runs on this timer (the frame hook stays off while it waits),
// on the main queue so ObjC work has a pool and cannot race the scene.
let probeTimer = null;
let probePending = false;

function probeTick() {
    log.mark('warp.probeTick');
    if (!autoVoid.on) return;
    try { if (frame.hookNeeded()) return; } catch (err) { /* */ }
    onBeforeFrame();
    try { warplog.sampleFast(); } catch (err) { /* */ }
    onFrame();
}

function ensureProbeTimer() {
    if (probeTimer !== null) return;
    probeTimer = setInterval(function () {
        if (!autoVoid.on) {
            clearInterval(probeTimer);
            probeTimer = null;
            return;
        }
        // The timer thread is not the main thread: ObjC work there has no
        // autorelease pool (leaked every tick) and raced the game's scene.
        // Run the tick on the main queue; skip if the last one has not run.
        if (probePending) return;
        probePending = true;
        try {
            ObjC.schedule(ObjC.mainQueue, function () {
                probePending = false;
                try { probeTick(); } catch (err) { /* */ }
            });
        } catch (err) {
            probePending = false;
        }
    }, 20);
}

function objectDropY() { return state.objectDropY; }

function setObjectDropY(y) {
    const n = Number(y);
    if (!isFinite(n)) return state.objectDropY;
    state.objectDropY = Math.max(-24, Math.min(24, n));
    return state.objectDropY;
}

function noteLoad() {
    cache.key = null;
    cache.cpKey = null;
    cache.cps = [];
    refreshCache();
    state.appliedThisLoad = false;
    state.focus = null;
    warplog.state.snapProbe = null;
    warplog.setCheckpointOverride(usingCheckpoint());
    if (autoVoid.on) {
        autoVoid.phase = 'arm';
        autoVoid.wait = 0;
        autoVoid.dropTry = 0;
        autoVoid.deathMark = 0;
    }
}

function restoreCheckpointIfWanted() {
    if (!state.wantCheckpoint || state.appliedThisLoad) return;
    if (!ball.levelLoaded() || !level.inLevel() || level.restartPending()) return;
    if (!hasCheckpoints()) {
        state.appliedThisLoad = true;
        warplog.setCheckpointOverride(false);
        return;
    }
    if (warplog.state.levelSpawn === null) return;
    applyCheckpoint(0);
    state.appliedThisLoad = true;
    warplog.setCheckpointOverride(true);
}

function autoVoidOn() { return autoVoid.on; }
function autoVoidPhase() { return autoVoid.phase; }

function skipIntroNow(wait) {
    if (!level.introPlaying()) return false;
    return level.skipIntro(wait >= 12);
}

function dismissReadyNow() {
    if (!level.messageUp()) return false;
    level.dismissMessage(frame.state.view);
    return true;
}

function autoPlayReady() {
    if (!level.inLevel() || level.inMainMenu() || level.complete()) return false;
    if (level.restartPending()) return false;
    if (level.introPlaying()) return false;
    if (level.messageUp()) return false;
    return true;
}

function onBeforeFrame() {
    if (!autoVoid.on) return;
    if (skipIntroNow(autoVoid.wait)) return;
    dismissReadyNow();
}

function setAutoVoid(on) {
    if (on && !warplog.levelCanProbe(loggedLevel())) {
        log.info(`auto force void: L${loggedLevel()} has no movables - not starting`, 'warp');
        return false;
    }
    autoVoid.on = !!on;
    autoVoid.wait = 0;
    autoVoid.dropTry = 0;
    if (!autoVoid.on) {
        autoVoid.phase = 'idle';
        warplog.noteAuto(false);
        log.info('auto force void off', 'warp');
        try { frame.syncHot(); } catch (err) { /* */ }
        return false;
    }
    autoVoid.phase = 'arm';
    autoVoid.deathMark = warplog.state.deaths || 0;
    warplog.noteAuto(true);
    log.info('auto force void on - voids on respawn and restart', 'warp');
    ensureProbeTimer();
    try { frame.syncHot(); } catch (err) { /* */ }
    return true;
}

function stepAutoVoid() {
    if (!autoVoid.on) return;
    if (!level.inLevel() || level.complete() || level.inMainMenu()) return;
    if (level.restartPending()) return;

    const deaths = warplog.state.deaths || 0;
    if (deaths < autoVoid.deathMark) autoVoid.deathMark = deaths;
    if (deaths > autoVoid.deathMark) {
        autoVoid.deathMark = deaths;
        autoVoid.phase = 'arm';
        autoVoid.wait = 0;
        autoVoid.dropTry = 0;
    }

    if (autoVoid.phase !== 'arm') return;
    if (level.introPlaying()) {
        autoVoid.wait += 1;
        skipIntroNow(autoVoid.wait);
        return;
    }
    if (dismissReadyNow()) {
        autoVoid.wait = 0;
        return;
    }
    if (warplog.state.voidArmed && !warplog.state.voidSpent) {
        autoVoid.phase = 'idle';
        return;
    }
    if (!warplog.state.moversReady) {
        autoVoid.wait += 1;
        if (autoVoid.wait > 90) autoVoid.phase = 'idle';
        return;
    }

    autoVoid.wait += 1;
    if (autoVoid.wait < 10) return;
    if (autoVoid.wait === 10 || autoVoid.wait % 28 === 0) {
        const r = forceVoid();
        if (r.ok) {
            autoVoid.dropTry += 1;
            log.info(`auto void ${r.label}`, 'warp');
        }
    }
    if (warplog.state.voidArmed && !warplog.state.voidSpent) {
        autoVoid.phase = 'idle';
        return;
    }
    if (autoVoid.wait > 140) autoVoid.phase = 'idle';
}

// ----------------------------------------------------------------- watching

function onFrame() {
    try {
        const macro = require('./macro');
        if (macro.state.mode === 'playing' || macro.state.mode === 'arming'
            || macro.state.mode === 'lingering') return;
        if (macro.hooksQuiet() && !autoVoid.on) return;
    } catch (err) { /* */ }
    if (!warplog.wantWatch()) return;
    log.mark('warp.onFrame');
    if (!level.playable() && !autoVoid.on) return;
    const started = level.started();
    const intro = level.introPlaying();
    const live = level.levelNumber();
    if ((loadWatch.started && !started) || (intro && !loadWatch.intro)) {
        noteLoad();
    }
    if (level.inLevel() && !level.complete() && live >= 0 && live !== loadWatch.level) {
        noteLoad();
        loadWatch.level = live;
    }
    loadWatch.started = started;
    loadWatch.intro = intro;

    restoreCheckpointIfWanted();

    const f = cache.finish || finish();
    const p = ball.physicsPosition();
    if (f !== null && p !== null) {
        const d = mem.length3(mem.sub3(p, f.position));
        if (state.closestFinish === null || d < state.closestFinish) {
            state.closestFinish = d;
        }
    }

    stepAutoVoid();
}

function install() {
    frame.onBeforeFrame(log.guard('deathwarp.skipIntro', onBeforeFrame), 'warp');
    frame.onAfterFrame(log.guard('deathwarp.onFrame', onFrame), 'warp');
}

function setWatching(value) {
    state.watching = !!value;
    state.lastComplete = state.watching ? isComplete() : false;
}

// Dump every distinct model name. On a level where nothing matches the known
// kill-volume names this is how you find out what it is actually called.
function names() {
    const counts = {};
    let unnamed = 0;
    scene.dump().forEach(m => {
        const key = m.name || '(unnamed)';
        if (!m.name) unnamed += 1;
        counts[key] = (counts[key] || 0) + 1;
    });
    if (unnamed > 0) {
        log.info(`${unnamed} model(s) have an empty name - those can still be `
            + 'ResetPlayer-shaped collision', 'scene');
    }
    const sorted = Object.keys(counts).sort();
    log.info(`${sorted.length} distinct model names in this level:`, 'scene');
    sorted.forEach(n => log.info(`  ${n} x${counts[n]}`, 'scene'));
    return counts;
}

module.exports = {
    state, install, setWatching,
    isComplete, finish, finishBase, respawn, checkpoints, killPlane,
    corridor, flatMiss, solve, evaluate, describe,
    aim, aimAt, known, knownEntry,
    goMovable, forceVoid,
    knockTargets, usefulTargets, probeBounds,
    movables, KNOWN,
    replayHit, names,
    checkpointTaken, clearCheckpoint, applyCheckpoint,
    wantCheckpoint, setWantCheckpoint, usingCheckpoint, hasCheckpoints,
    // AUTO PROBE / SEARCH are gone (zones are baked from the level files).
    autoOn: () => false,
    setAutoVoid, autoVoidOn, autoVoidPhase,
    objectDropY, setObjectDropY,
    TEST_DROP_HEIGHT, VOID_DROP_Y,
};
