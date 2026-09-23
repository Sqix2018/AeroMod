// Measures deaths instead of predicting them.
//
// The previous approach guessed the kill plane by looking for models named
// ResetPlayer or Floor, which found nothing on level 9, and predicted the warp
// spot from a ray that - on level 9 - rises as it leaves the finish and so never
// reaches the height people actually die at. Both were theory.
//
// This watches the ball instead. A respawn is unmistakable from the outside: in
// one frame the position jumps from wherever you were to the spawn point. So
// each frame it keeps the previous position, and when that jump happens it
// records the frame *before* it - which is exactly the "last visible coordinate
// before it updates to the spawn coordinate" you were reading off the HUD by
// hand. Then it watches the next handful of frames for the level-complete flag.
//
// That gives two things no amount of static analysis was producing:
//
//   - a measured kill height, per level, from real deaths
//   - a labelled set of death positions, each marked warp or no-warp
//
// The hits are written to Documents/aerox-tas so they survive a crash and
// accumulate across sessions, and the map draws them. Enough of them and the
// pattern is visible whether or not anyone has the right model yet.

const mem = require('../core/mem');
const log = require('../core/log');
const storage = require('../core/storage');
const ivars = require('../core/ivars');
const ball = require('../game/ball');
const scene = require('../game/scene');
const frame = require('../game/frame');
const level = require('../game/level');

// A jump this large in a single frame is a teleport, not motion. 12 was too
// small: restarting while still on the start pad (z off by ~13) looked like a
// death and stole the warp flag from the real ocean hit later in the same run.
const JUMP_THRESHOLD = 18;
// How close to the spawn the ball has to land for it to count as a respawn.
const SPAWN_TOLERANCE = 3;
// Real kill-plane deaths are under the map. A snap whose previous Y is still
// on the stage is a restart / StartPoint, not a ResetPlayer.
const KILL_Y_MAX = 0;
const VOID_ARM_Y = 0;
// A completion this soon after a death is the warp, not a normal finish.
const WARP_WINDOW_FRAMES = 75; // ticks a first-after-void death waits for the win flag
// Trailing positions kept so a hit can be replayed as an approach path.
const TRAIL = 30;

const state = {
    recording: false,  // console override; live watch is wantWatch()
    hold: false,       // FORCE VOID this load, even if they leave the WARP tab
    tab: false,        // WARP tab selected
    map: false,        // warp map overlay on
    auto: false,       // AUTO PROBE / SEARCH / AUTO VOID
    previous: null,
    trail: [],
    pending: null,     // a death waiting to see whether the level completes
    lastComplete: false,
    lastSpawn: null,
    deaths: 0,
    hits: [],          // loaded for the current level
    level: null,
    sceneKey: null,
    fastKey: null,
    closestFinish: null,
    finishPos: null,
    storedFinish: null,
    storedSpawn: null,
    storedCheckpoints: [],
    checkpoints: [],       // authored CheckPoint objects this scene
    landmarksScanned: false,
    landmarksLogged: false,
    wasStarted: false,
    wasIntro: false,
    smear: null,       // union of ball-sized boxes at real positions (not inflated)
    lastAabb: null,
    flareAabb: null,
    closestSmear: null,
    movers: [],        // dynamic bodies watched for a Floor/void hit
    moversReady: false,
    voidArmed: null,   // first movable that crossed into the void this load
    voidSpent: false,  // a ball death already consumed that arm
    levelSpawn: null,  // StartPoint / start pad, never the checkpoint
    useful: [],        // names that have actually hit the void
    mapLayer: 'live',  // 'live' | true | false
    markStamp: 0,
    refine: false,
    snapProbe: null,
    lastStampFp: '',
    lastStampLevel: null,
};

function fileName(levelIndex) {
    return `warp-level${String(levelIndex).padStart(3, '0')}.json`;
}

const LANDMARKS_FILE = 'warps-landmarks.json';
// Confirmed EndFlare XZ from live captures. Used when an old warp-level file
// was written from the menu and never stored a finish.
const KNOWN_FINISH = {
    9: { x: -4, y: 20.1, z: 64 },
    11: { x: 40, y: 24.1, z: -32 },
    28: { x: 0, y: 12.13, z: -88 },
    32: { x: 40, y: 30.13, z: 72 },
};
const KNOWN_START = {
    9: { x: 96, y: 9.69, z: 34 },
    28: { x: 0, y: 0.19, z: 8 },
};
const KNOWN_CP = {
    11: [{ name: 'CheckPoint', x: -64, y: 16, z: 8 }],
};

function loadLandmarks() {
    const data = storage.readJson(LANDMARKS_FILE);
    return (data && typeof data === 'object') ? data : {};
}

function copyPt(p) {
    if (!p) return null;
    const out = { x: p.x, y: p.y, z: p.z };
    if (p.name) out.name = p.name;
    return out;
}

function asPoint(c) {
    if (!c) return null;
    if (c.position) return { name: c.name, x: c.position.x, y: c.position.y, z: c.position.z };
    if (c.x === undefined) return null;
    return copyPt(c);
}

function mergeCheckpoints(prev, next) {
    const out = (prev || []).map(copyPt).filter(Boolean);
    (next || []).forEach(raw => {
        const p = asPoint(raw);
        if (!p) return;
        const hit = out.find(o => xzLen(o, p) < 8);
        if (hit) {
            if (p.name && (!hit.name || hit.name === 'spawn-jump')) hit.name = p.name;
            return;
        }
        out.push(p);
    });
    return out;
}

function nearAny(p, list, tol) {
    if (!p || !list) return false;
    const d = tol === undefined ? 8 : tol;
    return list.some(c => xzLen(c, p) < d);
}

const USEFUL_NAME_RE = /crate|barrel|keg|weight|target/i;
const SKIP_NAME_RE = /chain/i;
const LEVEL_FIRST = 1;
const LEVEL_LAST = 40;

function classifyNames(names) {
    const useful = [];
    const skip = [];
    const other = [];
    (names || []).forEach(n => {
        if (SKIP_NAME_RE.test(n || '')) skip.push(n);
        else if (USEFUL_NAME_RE.test(n || '')) useful.push(n);
        else other.push(n);
    });
    return { useful, skip, other };
}

function probeKind(movables) {
    if (!movables) return 'unknown';
    if (!(movables.count > 0)) return 'skip';
    const cls = classifyNames(movables.names);
    if (cls.useful.length) return 'crates';
    if (cls.other.length) return 'other';
    return 'skip';
}

function xzKey(p) {
    if (!p || p.x === undefined || p.z === undefined) return '';
    return `${Math.round(p.x * 10) / 10},${Math.round(p.z * 10) / 10}`;
}

function samePad(a, b) {
    return !!(a && b && xzLen(a, b) !== null && xzLen(a, b) < 1.5);
}

function sceneFingerprint() {
    let start = '';
    let finish = '';
    let cp = 0;
    let names = '';
    try {
        const s = scene.findOne('StartPoint');
        if (s && s.position) start = xzKey(s.position);
    } catch (err) { /* */ }
    try {
        const f = findFinish();
        if (f && f.position) finish = xzKey(f.position);
    } catch (err) { /* */ }
    try {
        cp = scene.find('CheckPoint').length;
    } catch (err) { /* */ }
    try {
        names = (snapshotMovables().names || []).join(',');
    } catch (err) { /* */ }
    return `${start}|${finish}|cp${cp}|${names}`;
}

function firstLevelPad() {
    return landmarkFor(LEVEL_FIRST);
}

function cloneOfFirst(levelIndex, start, finish, movables) {
    if (levelIndex === LEVEL_FIRST) return false;
    const first = firstLevelPad();
    const startSame = samePad(start, first.spawn);
    const finishSame = samePad(finish, first.finish);
    const names = (movables && movables.names || []).join(',');
    const firstNames = (first.movables && first.movables.names || []).join(',');
    const namesSame = !!(names && firstNames && names === firstNames);
    if (startSame && finishSame) return true;
    if (startSame && namesSame) return true;
    if (finishSame && namesSame) return true;
    if (startSame && !KNOWN_START[levelIndex]) return true;
    if (finishSame && !KNOWN_FINISH[levelIndex]) return true;
    return false;
}

function scrubClonedLandmarks() {
    const all = loadLandmarks();
    let changed = false;
    Object.keys(all).forEach(k => {
        const n = parseInt(k, 10);
        if (!isFinite(n) || n === LEVEL_FIRST) return;
        const cur = all[k];
        if (!cur || !cloneOfFirst(n, cur.spawn, cur.finish, cur.movables)) return;
        delete cur.spawn;
        delete cur.finish;
        delete cur.movables;
        delete cur.scanned;
        changed = true;
    });
    if (changed) storage.writeJson(LANDMARKS_FILE, all);
}

function rememberLandmark(levelIndex, piece) {
    if (levelIndex === null || levelIndex === undefined) return;
    if (cloneOfFirst(levelIndex, piece.spawn, piece.finish, piece.movables)) {
        piece = {
            checkpoints: piece.checkpoints,
            scanned: false,
        };
        if (!piece.checkpoints || !piece.checkpoints.length) return;
    }
    const all = loadLandmarks();
    const key = String(levelIndex);
    const cur = all[key] || {};
    let changed = false;
    ['finish', 'spawn'].forEach(field => {
        const p = piece[field];
        if (!p) return;
        if (field === 'spawn' && nearAny(p, cur.checkpoints, 8)) return;
        if (cloneOfFirst(levelIndex, field === 'spawn' ? p : null, field === 'finish' ? p : null, null)) {
            return;
        }
        const prev = cur[field];
        if (prev && xzLen(prev, p) < 0.5) return;
        cur[field] = { x: p.x, y: p.y, z: p.z };
        changed = true;
    });
    if (piece.checkpoints && piece.checkpoints.length) {
        const merged = mergeCheckpoints(cur.checkpoints, piece.checkpoints);
        if (merged.length !== (cur.checkpoints || []).length
            || merged.some((c, i) => !cur.checkpoints || xzLen(c, cur.checkpoints[i]) >= 0.5)) {
            cur.checkpoints = merged;
            cur.cpNone = false;
            changed = true;
        }
    } else if (piece.scanned && Array.isArray(piece.checkpoints) && piece.checkpoints.length === 0) {
        if (cur.checkpoints && cur.checkpoints.length) {
            cur.checkpoints = [];
            changed = true;
        }
        if (cur.cpNone !== true) {
            cur.cpNone = true;
            changed = true;
        }
    }
    if (piece.movables && !cloneOfFirst(levelIndex, piece.spawn || cur.spawn, piece.finish || cur.finish, piece.movables)) {
        const prev = cur.movables;
        const next = piece.movables;
        if (!prev || prev.count !== next.count
            || String(prev.names || '') !== String(next.names || '')) {
            cur.movables = {
                count: next.count | 0,
                names: (next.names || []).slice(),
                useful: next.useful | 0,
                other: next.other | 0,
            };
            changed = true;
        }
    }
    if (piece.scanned && !cur.scanned) {
        cur.scanned = true;
        changed = true;
    }
    if (!changed) return;
    all[key] = cur;
    storage.writeJson(LANDMARKS_FILE, all);
}

function landmarkFor(levelIndex) {
    const all = loadLandmarks();
    return all[String(levelIndex)] || {};
}

function pickFinish(levelIndex, data, hits) {
    if (KNOWN_FINISH[levelIndex]) return KNOWN_FINISH[levelIndex];
    if (hits) {
        for (let i = 0; i < hits.length; i++) {
            if (hits[i].finish && !cloneOfFirst(levelIndex, null, hits[i].finish, null)) {
                return hits[i].finish;
            }
        }
    }
    const live = (data && data.finish) || landmarkFor(levelIndex).finish;
    if (live && !cloneOfFirst(levelIndex, null, live, null)) return live;
    if (levelIndex === state.level) {
        const now = savedFinish();
        if (now && !cloneOfFirst(levelIndex, null, now, null)) return now;
    }
    return null;
}

function dropStartDupes(list, start) {
    const out = (list || []).map(copyPt).filter(Boolean);
    if (!start) return out;
    return out.filter(p => xzLen(p, start) >= 8);
}

function pickCheckpoints(levelIndex, data) {
    let list = [];
    list = mergeCheckpoints(list, data && data.checkpoints);
    list = mergeCheckpoints(list, landmarkFor(levelIndex).checkpoints);
    list = mergeCheckpoints(list, KNOWN_CP[levelIndex]);
    if (levelIndex === state.level) {
        list = mergeCheckpoints(list, state.checkpoints);
        list = mergeCheckpoints(list, state.storedCheckpoints);
    }
    const start = (data && data.startSpawn) || (data && data.spawn)
        || landmarkFor(levelIndex).spawn
        || KNOWN_START[levelIndex]
        || (levelIndex === state.level ? (state.levelSpawn || state.storedSpawn) : null);
    return dropStartDupes(list, start);
}

function pickStart(levelIndex, data, hits) {
    const cps = pickCheckpoints(levelIndex, data);
    function usable(p) {
        return !!(p && !nearAny(p, cps, 8) && !cloneOfFirst(levelIndex, p, null, null));
    }
    if (usable(KNOWN_START[levelIndex])) return KNOWN_START[levelIndex];
    if (hits) {
        for (let i = 0; i < hits.length; i++) {
            if (!hits[i].checkpoint && usable(hits[i].startSpawn || hits[i].spawn)) {
                return hits[i].startSpawn || hits[i].spawn;
            }
        }
    }
    if (usable(data && data.startSpawn)) return data.startSpawn;
    if (usable(data && data.spawn)) return data.spawn;
    const cached = landmarkFor(levelIndex).spawn;
    if (usable(cached)) return cached;
    if (levelIndex === state.level) {
        if (usable(state.levelSpawn)) return state.levelSpawn;
        if (usable(state.storedSpawn)) return state.storedSpawn;
    }
    if (hits) {
        for (let i = 0; i < hits.length; i++) {
            if (!hits[i].checkpoint && hits[i].spawn && usable(hits[i].spawn)) {
                return hits[i].spawn;
            }
        }
    }
    return null;
}

function nearestCheckpoint(p, cps) {
    if (!cps || !cps.length) return null;
    if (!p) return cps[0];
    let best = cps[0];
    let bestD = xzLen(p, cps[0]);
    for (let i = 1; i < cps.length; i++) {
        const d = xzLen(p, cps[i]);
        if (d !== null && (bestD === null || d < bestD)) {
            best = cps[i];
            bestD = d;
        }
    }
    return best;
}

function medianPoint(pts) {
    const list = (pts || []).filter(Boolean);
    if (!list.length) return null;
    const xs = list.map(p => p.x).sort((a, b) => a - b);
    const ys = list.map(p => p.y).sort((a, b) => a - b);
    const zs = list.map(p => p.z).sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    return { x: xs[mid], y: ys[mid], z: zs[mid] };
}

function zoneOrigin(isCp, hits, start, checkpoints) {
    if (isCp) {
        const guess = medianPoint(hits.map(h => h.checkpointPos || h.spawn));
        return nearestCheckpoint(guess || (hits[0] && hits[0].position), checkpoints)
            || guess
            || (hits[0] && hits[0].spawn)
            || null;
    }
    return start || (hits[0] && hits[0].startSpawn) || (hits[0] && hits[0].spawn) || null;
}

const GRID = 40;
const PATCH = 22;
const DUP_WARP = 8;
const MAX_WARP_PER_PATCH = 4;

const layer = { override: null };
let persistAt = 0;
let persistDirty = false;

function setCheckpointOverride(value) {
    layer.override = (value === true || value === false) ? value : null;
}

function checkpointOn() {
    if (layer.override !== null) return layer.override;
    if (state.levelSpawn === null || state.lastSpawn === null) return false;
    return mem.length3(mem.sub3(state.lastSpawn, state.levelSpawn)) > 1;
}

function gridKey(p) {
    return `${Math.round(p.x / GRID) * GRID},${Math.round(p.z / GRID) * GRID}`;
}

function fineKey(p) {
    const s = 2;
    return `${Math.round(p.x / s) * s},${Math.round(p.z / s) * s}`;
}

function xzDist(a, b) {
    if (a === null || b === null) return null;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function mapCheckpoint() {
    if (state.mapLayer === true || state.mapLayer === false) return state.mapLayer;
    return checkpointOn();
}

function hitsFor(checkpoint) {
    const flag = !!checkpoint;
    return state.hits.filter(h => !!h.checkpoint === flag);
}

function layerHits() {
    return hitsFor(mapCheckpoint());
}

function load(levelIndex) {
    if (state.level === levelIndex && Array.isArray(state.hits)) return state.hits;
    const data = storage.readJson(fileName(levelIndex));
    let hits = [];
    let useful = [];
    if (data !== null) {
        useful = Array.isArray(data.useful) ? data.useful : [];
        if (Array.isArray(data.hits)) {
            hits = data.version >= 2
                ? data.hits.filter(h => h.firstAfterVoid || h.miss)
                : data.hits.filter(h => h.warp || h.firstAfterVoid);
        }
    }
    state.hits = hits;
    state.useful = useful.filter(n => n && !/chain/i.test(n));
    state.level = levelIndex;
    state.storedFinish = (data && data.finish)
        ? data.finish
        : (KNOWN_FINISH[levelIndex] || null);
    state.storedSpawn = (data && data.startSpawn) || (data && data.spawn) || null;
    state.storedCheckpoints = Array.isArray(data && data.checkpoints) ? data.checkpoints : [];
    state.checkpoints = state.storedCheckpoints.slice();
    state.landmarksScanned = false;
    state.landmarksLogged = false;
    state.finishPos = null;
    state.flareAabb = null;
    state.closestFinish = null;
    state.markStamp += 1;
    return state.hits;
}

function persist(force) {
    try {
        const macro = require('./macro');
        const mode = require('./macro').state.mode;
        if (mode === 'playing' || mode === 'lingering' || mode === 'arming') return false;
    } catch (err) { /* */ }
    if (state.level === null) return false;
    persistDirty = true;
    const now = Date.now();
    if (!force && now < persistAt) return false;
    persistAt = now + 1500;
    persistDirty = false;
    const rawSpawn = state.levelSpawn || state.storedSpawn;
    const finish = savedFinish() || state.storedFinish;
    const checkpoints = dropStartDupes(
        (state.checkpoints && state.checkpoints.length)
            ? state.checkpoints
            : state.storedCheckpoints,
        rawSpawn);
    const movables = snapshotMovables();
    const cloned = cloneOfFirst(state.level, rawSpawn, finish, movables);
    const spawn = cloned ? null : rawSpawn;
    if (!cloned) {
        rememberLandmark(state.level, { finish, spawn, checkpoints, movables, scanned: true });
    }
    return storage.writeJson(fileName(state.level), {
        version: 4,
        level: state.level,
        useful: state.useful,
        hits: state.hits.map(compactHit),
        finish: cloned ? (KNOWN_FINISH[state.level] || null) : finish,
        spawn,
        startSpawn: spawn,
        checkpoints,
        movables: cloned ? null : movables,
    });
}

function savedFinish() {
    if (state.finishPos && state.finishPos !== false) return state.finishPos;
    try {
        const f = require('./deathwarp').finish();
        if (f && f.position) return f.position;
    } catch (err) { /* */ }
    return null;
}

function rememberUseful(name) {
    if (!name || /chain/i.test(name) || state.useful.indexOf(name) !== -1) return;
    state.useful.push(name);
}

function shouldKeep(entry) {
    const bucket = hitsFor(entry.checkpoint);
    if (entry.refine || entry.miss) {
        if (entry.refine && !entry.miss && !entry.firstAfterVoid) return false;
        const key = (entry.refine ? fineKey : gridKey)(entry.position);
        const same = h => (entry.refine ? fineKey : gridKey)(h.position) === key;
        if (entry.miss || !entry.warp) {
            return !bucket.some(h => !h.warp && same(h));
        }
        return !bucket.some(h => h.warp && same(h));
    }
    if (!entry.firstAfterVoid) return false;
    if (!entry.warp) {
        const key = gridKey(entry.position);
        return !bucket.some(h => !h.warp && gridKey(h.position) === key);
    }
    const warps = bucket.filter(h => h.warp);
    if (warps.some(h => xzDist(h.position, entry.position) < DUP_WARP)) return false;
    const near = warps.filter(h => xzDist(h.position, entry.position) < PATCH);
    return near.length < MAX_WARP_PER_PATCH;
}

function compactHit(h) {
    if (!h) return h;
    if (h.warp) {
        const o = {
            position: h.position,
            spawn: h.spawn,
            startSpawn: h.startSpawn || null,
            checkpointPos: h.checkpointPos || null,
            finish: h.finish || null,
            warp: true,
            firstAfterVoid: !!h.firstAfterVoid,
            checkpoint: !!h.checkpoint,
            voidObject: h.voidObject || null,
            source: h.source || 'log',
            at: h.at,
        };
        if (h.trail && h.trail.length) o.trail = h.trail;
        if (h.note) o.note = h.note;
        return o;
    }
    return {
        position: h.position,
        spawn: h.spawn,
        startSpawn: h.startSpawn || null,
        checkpointPos: h.checkpointPos || null,
        finish: h.finish || null,
        warp: false,
        miss: !!h.miss,
        firstAfterVoid: !!h.firstAfterVoid,
        checkpoint: !!h.checkpoint,
        voidObject: h.voidObject || null,
        reason: h.reason || (h.firstAfterVoid ? 'death no warp' : 'miss'),
        at: h.at,
    };
}

function trimHits() {
    const MAX = 900;
    const MAX_MISS = 520;
    const warps = [];
    const misses = [];
    for (let i = 0; i < state.hits.length; i++) {
        if (state.hits[i].warp) warps.push(state.hits[i]);
        else misses.push(state.hits[i]);
    }
    const missBudget = Math.min(MAX_MISS, Math.max(0, MAX - warps.length));
    const missOut = misses.length > missBudget
        ? misses.slice(misses.length - missBudget)
        : misses;
    if (warps.length + missOut.length === state.hits.length) return;
    state.hits = warps.concat(missOut);
}

// Warps outside the zone baked from the level file (warpzones.js). Those are
// the only ones worth keeping now: everything inside the zone is predicted.
function offModel(h) {
    if (!h || !h.warp || !h.position) return false;
    let z = null;
    try { z = require('./warpzones').zonesFor(state.level); } catch (err) { return true; }
    if (!z || !z.exact) return true;
    const layer = z.layers.find(l => l.cp === !!h.checkpoint);
    if (!layer || !layer.ok) return true;
    const r = layer.rect;
    return h.position.x < r.minX || h.position.x > r.maxX
        || h.position.z < r.minZ || h.position.z > r.maxZ;
}

// Deaths and predicted warps are no longer stored; the recorder still tracks
// them live (AUTO VOID needs the death count). Off-model warps are saved.
function record(entry) {
    if (!entry || !entry.warp) return false;
    if (!offModel(entry)) {
        log.info(`warp at ${fmt(entry.position)} is inside the predicted zone - not stored`, 'warp');
        return false;
    }
    log.info(`OFF-MODEL WARP at ${fmt(entry.position)} (${entry.checkpoint ? 'CP on' : 'CP off'})`
        + ` - outside the predicted zone, saved to the map`, 'warp');
    if (!shouldKeep(entry)) return false;
    if (entry.voidObject) rememberUseful(entry.voidObject);
    if (!entry.warp) {
        entry.trail = [];
        if (!entry.reason) entry.reason = entry.miss ? 'no kill' : 'death no warp';
    }
    state.hits.push(entry);
    trimHits();
    killCache.stamp = -1;
    state.markStamp += 1;
    persist(true);
    return true;
}

function recordMiss(position, reason) {
    if (position === null) return false;
    return record({
        position: { x: position.x, y: position.y, z: position.z },
        spawn: state.lastSpawn,
        startSpawn: state.levelSpawn || state.storedSpawn,
        checkpointPos: checkpointOn()
            ? (nearestCheckpoint(state.lastSpawn, state.checkpoints) || state.lastSpawn)
            : null,
        warp: false,
        miss: true,
        refine: !!state.refine,
        firstAfterVoid: false,
        checkpoint: checkpointOn(),
        voidObject: state.voidArmed === null ? null : state.voidArmed.name,
        reason: reason || 'no kill',
        at: Date.now(),
    });
}

function hits() { return state.hits; }
function warps() { return state.hits.filter(h => h.warp); }

// The kill height, measured. Deaths cluster at the height the trigger fires, so
// the median of observed deaths is a far better answer than any model lookup.
//
// Memoised against the hit count: the UI asks for this several times per refresh
// and it was re-sorting the whole list every time.
const killCache = { stamp: -1, value: null };

function measuredKillY() {
    if (killCache.stamp === state.hits.length) return killCache.value;

    const ys = state.hits.filter(h => !h.miss).map(h => h.position.y)
        .filter(y => isFinite(y) && y < KILL_Y_MAX)
        .sort((a, b) => a - b);
    killCache.stamp = state.hits.length;
    killCache.value = ys.length === 0 ? null : {
        y: ys[Math.floor(ys.length / 2)],
        low: ys[0],
        high: ys[ys.length - 1],
        samples: ys.length,
    };
    return killCache.value;
}

function summary() {
    const k = measuredKillY();
    const layer = layerHits();
    return {
        level: state.level,
        deaths: layer.length,
        warps: layer.filter(h => h.warp).length,
        killY: k,
        checkpoint: mapCheckpoint(),
        probed: layer.filter(h => !h.warp).length,
    };
}

function findFinish() {
    let f = scene.findOne('EndFlare', { exact: true });
    if (f && f.position) return f;
    f = scene.findOne('EndFlare');
    return (f && f.position) ? f : null;
}

function captureFinish() {
    const f = findFinish();
    if (!f || !f.position) return null;
    const pos = copyPt(f.position);
    const same = state.finishPos && state.finishPos !== false
        && xzLen(state.finishPos, pos) < 0.5;
    state.finishPos = pos;
    state.storedFinish = pos;
    if (!same && !cloneOfFirst(state.level, null, pos, null)) {
        rememberLandmark(state.level, { finish: pos });
        persist(true);
        if (state.landmarksLogged) log.info(`landmarks finish ${fmt(pos)}`, 'warp');
    }
    return pos;
}

function scanLandmarks() {
    const startObj = scene.findOne('StartPoint');
    const start = (startObj && startObj.position) ? copyPt(startObj.position) : null;
    if (start) {
        state.levelSpawn = start;
        state.storedSpawn = start;
    }
    const foundRaw = scene.find('CheckPoint')
        .map(asPoint)
        .filter(Boolean);
    const found = dropStartDupes(foundRaw, start);
    if (found.length) {
        state.checkpoints = mergeCheckpoints(state.storedCheckpoints, found);
        state.storedCheckpoints = state.checkpoints;
    }
    const finish = captureFinish() || savedFinish() || state.storedFinish;
    const movables = snapshotMovables();
    if (cloneOfFirst(state.level, start, finish, movables)) {
        log.info(`landmarks skip L${state.level} - still previous scene`, 'warp');
        return movables;
    }
    rememberLandmark(state.level, {
        spawn: start,
        finish,
        checkpoints: found,
        movables,
        scanned: true,
    });
    state.lastStampFp = sceneFingerprint();
    state.lastStampLevel = state.level;
    if (!state.landmarksLogged) {
        const cpTxt = found.length
            ? found.map(c => `${c.name || 'CP'} ${fmt(c)}`).join(', ')
            : 'none';
        const mv = movables.count
            ? `${movables.count} (${movables.names.join(', ')})`
            : 'none';
        log.info(`landmarks start ${start ? fmt(start) : '?'}  cp ${cpTxt}`
            + `  finish ${finish ? fmt(finish) : '?'}  movables ${mv}`
            + `  ${probeKind(movables)}`, 'warp');
        state.landmarksLogged = true;
    }
    return movables;
}

function snapshotMovables() {
    let list = state.movers || [];
    if (!list.length) {
        try {
            list = scene.dynamics().map(m => ({ name: m.name || '(unnamed)' }));
        } catch (err) { list = []; }
    }
    const names = [];
    const seen = {};
    list.forEach(m => {
        const n = m.name || '(unnamed)';
        if (seen[n]) return;
        seen[n] = true;
        names.push(n);
    });
    const cls = classifyNames(names);
    return {
        count: list.length,
        names,
        useful: cls.useful.length,
        other: cls.other.length,
    };
}

function stampMovablesNow() {
    if (state.level === null) return null;
    const movables = snapshotMovables();
    rememberLandmark(state.level, { movables, scanned: true });
    return movables;
}

function stampScene() {
    scanLandmarks();
    state.landmarksScanned = true;
    if (!state.moversReady) refreshMovers();
    else stampMovablesNow();
    persist(true);
    return snapshotMovables();
}

function flareAabb() {
    const f = scene.findOne('EndFlare', { exact: true });
    if (f === null || f.model === undefined) return false;
    try {
        const rb = f.model.add(ivars.offsetOf('synNode', 'rigidBody'))
            .readPointer();
        if (!rb.isNull()) {
            const box = ball.aabbOf(rb);
            if (box !== null) return box;
        }
    } catch (err) { /* */ }
    if (f.position === null) return false;
    return mem.aabbAround(f.position, f.radius > 0 ? f.radius : 2.5);
}

function commitPending() {
    if (state.pending === null) return false;
    const entry = state.pending.entry;
    state.pending = null;
    if (entry.firstAfterVoid) return record(entry);
    return false;
}

function resetLoad(reason) {
    // Auto restart used to wipe this before the 12-frame warp window
    // called record(), so the log showed deaths the map never got.
    commitPending();
    const had = state.deaths > 0 || state.smear !== null;
    state.deaths = 0;
    state.pending = null;
    state.previous = null;
    state.trail = [];
    state.closestFinish = null;
    state.finishPos = null;
    state.smear = null;
    state.lastAabb = null;
    state.flareAabb = null;
    state.closestSmear = null;
    state.movers = [];
    state.moversReady = false;
    state.voidArmed = null;
    state.voidSpent = false;
    state.levelSpawn = null;
    state.landmarksScanned = false;
    state.hold = false;
    try { scene.invalidateDynamics(); } catch (err) { /* */ }
    if (reason && had) log.info(`first-of-load reset (${reason})`, 'warp');
}

function dropScenePins() {
    try { commitPending(); } catch (err) { /* */ }
    state.movers = [];
    state.moversReady = false;
    state.fastKey = null;
    state.voidArmed = null;
    state.previous = null;
    try { scene.invalidateDynamics(); } catch (err) { /* */ }
}

function refreshMovers() {
    state.movers = scene.dynamics().map(m => ({
        name: m.name || '(unnamed)',
        model: m.model,
        last: null,
        lastY: null,
        home: null,
        voided: false,
    }));
}

function xz2(a, b) {
    if (a === null || b === null) return 1e9;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
}

function markArmed(mover, pos, how) {
    mover.voided = true;
    if (state.voidArmed === null) {
        state.voidArmed = {
            name: mover.name,
            position: pos || mover.last,
            frame: frame.state.frame,
        };
        rememberUseful(mover.name);
        persist();
        log.info(`ARMED ${mover.name} ${how}`
            + ' - first ball death can warp', 'warp');
    } else {
        log.info(`${mover.name} also ${how}`, 'warp');
    }
}

function watchMovers() {
    if (!state.moversReady) {
        refreshMovers();
        state.moversReady = true;
        if (state.movers.length > 0) {
            log.debug(`watching ${state.movers.length} movable(s): `
                + state.movers.map(m => m.name).join(', '), 'warp');
        }
        stampMovablesNow();
    }
    for (let i = 0; i < state.movers.length; i++) {
        const mover = state.movers[i];
        if (mover.voided) continue;
        const pos = scene.physicsPositionOf(mover.model);
        if (pos === null) {
            if (mover.lastY !== null) {
                markArmed(mover, mover.last, `left the world at ${fmt(mover.last)}`);
            }
            continue;
        }
        if (mover.home === null) {
            mover.home = pos;
            mover.last = pos;
            mover.lastY = pos.y;
            continue;
        }
        const crossed = pos.y < VOID_ARM_Y && mover.lastY >= VOID_ARM_Y;
        const wasAway = xz2(mover.last, mover.home) > 256;
        const nowHome = xz2(pos, mover.home) < 144;
        const snapped = wasAway && nowHome;
        mover.last = pos;
        mover.lastY = pos.y;
        if (crossed) markArmed(mover, pos, `hit the void at ${fmt(pos)}`);
        else if (snapped) markArmed(mover, pos, `voided and snapped back at ${fmt(pos)}`);
    }
}

function treeHint() {
    const flareBox = state.flareAabb === false ? null : state.flareAabb;
    const gap = mem.aabbGap(state.smear, flareBox);
    const last = mem.aabbGap(state.lastAabb, flareBox);
    return {
        smear: state.smear,
        lastAabb: state.lastAabb,
        flareAabb: flareBox,
        smearGap: gap,
        lastGap: last,
        closestSmear: state.closestSmear,
        // The working guess: the tree only has a chance of pairing EndFlare
        // on death if this load's AABB smear has already been near it.
        nearFlare: gap !== null && gap < 12,
        voidArmed: state.voidArmed,
        voidSpent: state.voidSpent,
        movables: state.movers.length,
    };
}

function wantWatch() {
    try {
        if (!require('../core/budget').warpOn()) return false;
    } catch (err) { /* */ }
    // Map on, AUTO VOID, or a console recording. Just having the WARP tab
    // open used to turn the per-frame hook on too.
    return !!(state.recording || state.hold || state.map || state.auto);
}

// null = this level has never been stamped. 0 = scanned, nothing to drop.
function knownMovableCount(levelIndex) {
    const n = (levelIndex === undefined || levelIndex === null) ? logLevelNumber() : levelIndex;
    if (n === null || n < 0) return null;
    const lm = landmarkFor(n);
    if (!lm || !lm.movables || lm.movables.count === undefined) return null;
    return lm.movables.count | 0;
}

// AUTO and the warp hook have nothing to do on a scanned level with no movables.
function levelCanProbe(levelIndex) {
    const count = knownMovableCount(levelIndex);
    if (count === null) return true;
    const n = (levelIndex === undefined || levelIndex === null) ? logLevelNumber() : levelIndex;
    return probeKind(landmarkFor(n).movables) !== 'skip';
}

// Per-frame JS hook. Manual record/hold still hooks. A warp tab on an empty
// level does not: that was hook=on why=warp with 0 movables, climbing rss.
function wantFrameWatch() {
    if (!wantWatch()) return false;
    if (state.recording || state.hold) return true;
    if (!levelCanProbe()) return false;
    if (state.landmarksScanned && state.movers.length === 0 && knownMovableCount() === null) {
        return false;
    }
    return true;
}

function releaseIdleBuffers(why) {
    const had = state.movers.length || state.trail.length || state.smear;
    state.previous = null;
    state.trail = [];
    state.smear = null;
    state.lastAabb = null;
    state.movers = [];
    state.moversReady = false;
    state.voidArmed = null;
    try { scene.invalidateDynamics(); } catch (err) { /* */ }
    if (had && why) log.info(`warp buffers released (${why})`, 'mem');
}

function logLevelNumber() {
    if (level.complete() && state.level !== null) return state.level;
    return level.levelNumber();
}

function noteTab(on) {
    state.tab = !!on;
    if (!on) return;
    const n = logLevelNumber();
    if (!levelCanProbe(n)) {
        log.info(`L${n} has no movables - warp hook stays off`, 'warp');
    }
}
function noteMap(on) { state.map = !!on; }
function noteAuto(on) { state.auto = !!on; }

function arm() { state.hold = true; }

// The map can open while the frame hook is off (onFrame is what loads a
// level's file), which left it blank until something turned the hook on.
function syncLevel() {
    try {
        if (!level.inLevel() || level.inMainMenu() || level.complete()) return state.level;
        const n = logLevelNumber();
        if (n >= 0 && n !== state.level) load(n);
    } catch (err) { /* */ }
    return state.level;
}

function onFrame() {
    if (!wantWatch()) {
        if (state.movers.length || state.trail.length || state.smear || state.previous) {
            releaseIdleBuffers(null);
        }
        return;
    }
    if (!level.inLevel() || level.inMainMenu()) {
        state.previous = null;
        return;
    }

    // Pin the log to the loaded scene, not DAT_levelNumber. That global
    // increments on a win *before* the scene unloads, which is why level 9
    // deaths were being written into the level 11 file.
    const scenePtr = mem.global('scene').readPointer();
    const sceneKey = scenePtr.isNull() ? null : scenePtr.toString();
    const logLevel = logLevelNumber();
    if (sceneKey !== state.sceneKey) {
        state.sceneKey = sceneKey;
        resetLoad(null);
        if (sceneKey !== null && logLevel >= 0) load(logLevel);
    }

    // Scene pointer is often reused across loadLevel, so the log would keep
    // showing level 11's baked warp on every later level. DAT_levelNumber
    // increments on a win *before* unload, so ignore it while complete.
    const liveLevel = logLevel;
    if (sceneKey !== null && level.inLevel() && !level.complete()
        && liveLevel >= 0 && liveLevel !== state.level) {
        load(liveLevel);
    }

    // loadLevel: often keeps the same scene pointer, so a restart was still
    // counting as death #4. started falling or the intro starting is a new load.
    const started = level.started();
    const intro = level.introPlaying();
    if ((state.wasStarted && !started) || (intro && !state.wasIntro)) {
        resetLoad(state.wasStarted && !started ? 'level restarted' : 'intro started');
        if (sceneKey !== null && liveLevel >= 0 && liveLevel !== state.level
            && !level.complete()) {
            load(liveLevel);
        }
    }
    state.wasStarted = started;
    state.wasIntro = intro;

    if (!state.landmarksScanned) {
        const fp = sceneFingerprint();
        const sameScene = !!(state.lastStampFp && fp === state.lastStampFp
            && state.level !== state.lastStampLevel);
        if (!sameScene) {
            scanLandmarks();
            state.landmarksScanned = true;
            persist(true);
        }
    }
    if (!state.finishPos || state.finishPos === false) {
        captureFinish();
    }

    let playing = false;
    try {
        const mode = require('./macro').state.mode;
        playing = mode === 'playing' || mode === 'arming' || mode === 'lingering';
    } catch (err) { /* */ }
    if (playing) return;
    try {
        if (require('./macro').hooksQuiet()) return;
    } catch (err) { /* */ }

    const p = ball.physicsPosition();
    if (p === null) { state.previous = null; return; }

    watchMovers();

    // Use the ball's real size at its real position. The proxy AABB is inflated
    // on TELEPORT, which was reporting smear OVERLAP after a single jump.
    if (!ball.moving()) {
        const box = mem.aabbAround(p, 1);
        state.lastAabb = box;
        state.smear = mem.aabbUnion(state.smear, box);
    }
    if (state.flareAabb === null) state.flareAabb = flareAabb();
    const flareBox = state.flareAabb === false ? null : state.flareAabb;
    const smearGap = mem.aabbGap(state.smear, flareBox);
    if (smearGap !== null
        && (state.closestSmear === null || smearGap < state.closestSmear)) {
        state.closestSmear = smearGap;
    }

    if (state.finishPos && state.finishPos !== false) {
        const d = mem.length3(mem.sub3(p, state.finishPos));
        if (state.closestFinish === null || d < state.closestFinish) {
            state.closestFinish = d;
        }
    }

    noteBall(p);
}

// Ball jump and mover watch without walking the scene. AUTO calls this from
// a timer so processGameFrame stays on the game's own IMP.
function sampleFast() {
    if (!wantWatch()) return;
    let key = null;
    try {
        const scenePtr = mem.global('scene').readPointer();
        key = scenePtr.isNull() ? null : scenePtr.toString();
    } catch (err) { return; }
    // A reload of the same level often reuses the scene pointer, so the key
    // alone kept the freed level's model pointers (ObjC on them = read 0x1c
    // crash in the intro). An intro starting or the win flag clearing is a
    // new load too.
    let intro = false;
    let done = false;
    try {
        const lv = require('../game/level');
        intro = lv.introPlaying();
        done = lv.complete();
    } catch (err) { /* */ }
    const reloaded = (intro && !state.fastIntro) || (!done && state.fastDone);
    state.fastIntro = intro;
    state.fastDone = done;
    if (key !== state.fastKey || reloaded) {
        state.fastKey = key;
        // A death still inside its warp window is recorded, not dropped.
        try { commitPending(); } catch (err) { /* */ }
        state.movers = [];
        state.moversReady = false;
        state.voidArmed = null;
        state.voidSpent = false;
        state.previous = null;
        state.deaths = 0;
        state.trail = [];
        state.pending = null;
        try { scene.invalidateDynamics(); } catch (err) { /* */ }
        if (key === null) return;
    }
    let inLv = false;
    try {
        const level = require('../game/level');
        inLv = level.inLevel() && !level.inMainMenu();
    } catch (err) { return; }
    if (!inLv) return;
    if (!state.moversReady) {
        refreshMovers();
        state.moversReady = true;
        if (state.movers.length > 0) {
            log.debug(`watching ${state.movers.length} movable(s): `
                + state.movers.map(m => m.name).join(', '), 'warp');
        }
    }
    watchMovers();
    const p = ball.physicsPosition();
    if (p === null) {
        state.previous = null;
        return;
    }
    noteBall(p);
}

function noteBall(p) {
    const spawn = ball.spawnPosition();

    // A checkpoint rewrites the spawn point mid-run; that changes which deaths
    // are comparable, so mark it in the log and on the hits that follow.
    if (spawn !== null && state.lastSpawn !== null
        && mem.length3(mem.sub3(spawn, state.lastSpawn)) > 1) {
        log.debug(`spawn point is now ${fmt(spawn)}`, 'warp');
        if (state.levelSpawn
            && mem.length3(mem.sub3(spawn, state.levelSpawn)) > 1) {
            const jumped = [{ name: 'spawn-jump', x: spawn.x, y: spawn.y, z: spawn.z }];
            state.checkpoints = mergeCheckpoints(state.checkpoints, jumped);
            rememberLandmark(state.level, { checkpoints: jumped });
        }
    }
    if (spawn !== null) {
        if (state.levelSpawn === null && !nearAny(spawn, state.checkpoints, 8)) {
            state.levelSpawn = spawn;
            rememberLandmark(state.level, { spawn });
            persist(true);
        }
        state.lastSpawn = spawn;
    }

    const complete = level.complete();

    // Detect the reset FIRST. EndFlare is set in the same callback that
    // teleports the ball, so by the time this hook runs complete is already
    // true and the ball is already at spawn. Looking for the complete edge
    // before recording the death is what produced "real hit was spawn" and
    // a warp count of 0.
    if (state.previous !== null && spawn !== null) {
        const moved = mem.length3(mem.sub3(p, state.previous));
        const atSpawn = mem.length3(mem.sub3(p, spawn)) < SPAWN_TOLERANCE;
        const wasAway = mem.length3(mem.sub3(state.previous, spawn)) > JUMP_THRESHOLD;
        const fromBelow = state.previous.y < KILL_Y_MAX;

        if (moved > JUMP_THRESHOLD && atSpawn && wasAway && fromBelow) {
            state.deaths += 1;
            const warpedNow = complete;
            const armed = state.voidArmed;
            const firstAfterVoid = armed !== null && !state.voidSpent;
            let pos = state.previous;
            if (state.refine && state.snapProbe !== null) {
                const dx = pos.x - state.snapProbe.x;
                const dz = pos.z - state.snapProbe.z;
                if (dx * dx + dz * dz < 64) {
                    pos = { x: state.snapProbe.x, y: pos.y, z: state.snapProbe.z };
                }
            }
            const entry = {
                position: pos,
                spawn,
                startSpawn: state.levelSpawn || state.storedSpawn,
                checkpointPos: checkpointOn()
                    ? (nearestCheckpoint(spawn, state.checkpoints) || spawn)
                    : null,
                finish: savedFinish() || state.storedFinish,
                frame: frame.state.frame,
                time: frame.runTimer(),
                warp: warpedNow,
                refine: !!state.refine,
                firstOfLoad: state.deaths === 1,
                firstAfterVoid,
                checkpoint: checkpointOn(),
                voidObject: armed === null ? null : armed.name,
                voidAt: armed === null ? null : armed.position,
                trail: warpedNow ? state.trail.slice(-TRAIL) : [],
                reason: warpedNow ? undefined : 'death no warp',
                at: Date.now(),
            };
            if (armed !== null) state.voidSpent = true;
            if (warpedNow) creditWarpUnlock();
            const voidTxt = armed === null ? '  (not armed, skipped)'
                : firstAfterVoid ? `  FIRST after ${armed.name} void`
                : `  after ${armed.name} void, already spent`;
            log.info(
                `${warpedNow ? 'DEATH WARP' : 'death'} #${state.deaths} `
                + `(${entry.checkpoint ? 'CP on' : 'CP off'}) `
                + `at ${fmt(state.previous)} -> spawn ${fmt(spawn)}`
                + voidTxt,
                'warp');
            if (state.pending !== null && state.pending.entry.firstAfterVoid) {
                record(state.pending.entry);
            }
            if (!firstAfterVoid) {
                state.pending = null;
                state.hold = false;
            } else if (warpedNow) {
                record(entry);
                state.pending = null;
                state.hold = false;
            } else {
                state.pending = { entry, age: 0 };
            }
            state.trail = [];
        }
    }

    if (state.pending !== null) {
        state.pending.age += 1;
        if (complete && !state.lastComplete) {
            state.pending.entry.warp = true;
            creditWarpUnlock();
            log.info(`DEATH WARP at ${fmt(state.pending.entry.position)} `
                + `(${state.pending.age} frames after the reset)`, 'warp');
        }
        if (state.pending.entry.warp || state.pending.age >= WARP_WINDOW_FRAMES) {
            if (state.pending.entry.firstAfterVoid) record(state.pending.entry);
            state.pending = null;
            state.hold = false;
        }
    }

    if (state.voidArmed && !state.voidSpent) {
        state.trail.push({ x: p.x, y: p.y, z: p.z });
        if (state.trail.length > TRAIL * 2) state.trail.splice(0, state.trail.length - TRAIL);
    }

    state.previous = p;
    state.lastComplete = complete;
}

function creditWarpUnlock() {
    try {
        if (require('./deathwarp').autoOn()) return;
        const n = state.level;
        if (n === null || n < 0) return;
        require('./achievements').noteWarp(n, frame.runTimer());
    } catch (err) { /* */ }
}

function hypot2(dx, dz) {
    return Math.sqrt(dx * dx + dz * dz);
}

function xzLen(a, b) {
    if (!a || !b) return null;
    return hypot2(a.x - b.x, a.z - b.z);
}

function fmt(p) {
    return p === null ? 'null'
        : `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
}

function install() {
    frame.onAfterFrame(log.guard('warplog.onFrame', onFrame), 'warp');
    log.info('death recorder idle until WARP', 'warp');
}

function setRecording(value) { state.recording = !!value; }

function clear() {
    state.hits = [];
    state.pending = null;
    state.markStamp += 1;
    persist();
    log.info('cleared recorded deaths for this level', 'warp');
}

function clearProbes() {
    const kept = state.hits.filter(h => h.warp);
    const dropped = state.hits.length - kept.length;
    state.hits = kept;
    state.pending = null;
    killCache.stamp = -1;
    state.markStamp += 1;
    persist();
    log.info(`cleared ${dropped} failed probe(s); ${kept.length} warp(s) kept`, 'warp');
}

function cycleMapLayer() {
    state.mapLayer = state.mapLayer === 'live' ? false
        : state.mapLayer === false ? true
        : 'live';
    state.markStamp += 1;
    return state.mapLayer;
}

module.exports = {
    state, install, syncLevel, setRecording, wantWatch, wantFrameWatch, levelCanProbe, arm, noteTab, noteMap, noteAuto,
    load, hits, warps, hitsFor, layerHits,
    measuredKillY, summary, clear, clearProbes, fmt, treeHint, offModel,
    checkpointOn, setCheckpointOverride, mapCheckpoint, cycleMapLayer, gridKey, fineKey, GRID,
    rememberUseful, commitPending, recordMiss, resetLoad, dropScenePins, sampleFast,
    WARP_WINDOW_FRAMES,
    stampScene, sceneFingerprint, LEVEL_FIRST, LEVEL_LAST, probeKind,
    releaseIdleBuffers, loadLandmarks,
};
