// Per-level split points and run comparison against the TAS-local gold.
//
// Split *points* are boxes in the level that fire when the ball crosses them.
// They live in Documents/aerox-tas and survive a restart. Split *times* belong
// to a single run; finishing a real (non-warp) run keeps them, and if that run
// is the fastest TAS completion of the level they become the comparison gold.
// Game Center / menu bests are a different store - this file never writes those.

const storage = require('../core/storage');
const log = require('../core/log');
const ball = require('../game/ball');
const frame = require('../game/frame');
const level = require('../game/level');
const warplog = require('./warplog');
const deathwarp = require('./deathwarp');

const HALF = 20;
const FINISH_NAME = 'Finish';

const state = {
    level: null,
    points: [],
    gold: null,          // { time, splits: [{ name, time, segment }] }
    run: null,           // live or frozen run
    frozen: false,
    lastComplete: false,
    lastInLevel: false,
    lastStarted: false,
    lastDeaths: 0,
    lastPos: null,
    installed: false,
    showOnMap: false,
    resetOnDeath: false,
    ignoreHits: 0,
    teleportIndex: 0,
    pendingSlide: null,  // split name waiting until the slide arrives
};

function fileName(n) {
    return `splits-level${String(n).padStart(3, '0')}.json`;
}

function fmtTime(t) {
    if (!isFinite(t)) return '--';
    if (t < 60) return t.toFixed(2);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const body = s.toFixed(2);
    return `${m}:${body.length < 5 ? '0' + body : body}`;
}

function fmtDelta(d) {
    if (!isFinite(d)) return '';
    const sign = d > 0.005 ? '+' : d < -0.005 ? '-' : '';
    return `${sign}${Math.abs(d).toFixed(2)}`;
}

function emptyRun() {
    return {
        splits: [], hit: {}, inside: {}, exitArm: {},
        time: 0, finished: false, segmentStart: 0,
    };
}

function loadLevel(n) {
    if (n < 0) {
        state.level = null;
        state.points = [];
        state.gold = null;
        return;
    }
    if (state.level === n) return;
    const data = storage.readJson(fileName(n));
    state.level = n;
    state.points = (data && Array.isArray(data.points))
        ? data.points.map(p => {
            const half = p.half > 0 ? p.half : HALF;
            return Object.assign({}, p, { half: half < 16 ? HALF : half });
        })
        : [];
    state.gold = (data && data.gold && typeof data.gold.time === 'number')
        ? data.gold : null;
    if (!state.frozen) resetRun();
}

function persist() {
    if (state.level === null) return false;
    return storage.writeJson(fileName(state.level), {
        version: 1,
        level: state.level,
        points: state.points,
        gold: state.gold,
    });
}

function resetRun() {
    state.run = emptyRun();
    state.frozen = false;
    state.lastPos = null;
    state.ignoreHits = 0;
    if (level.inLevel() && level.started() && !level.complete()) {
        state.run.segmentStart = level.runTimer();
    }
}

function beginRun() {
    resetRun();
}

function insidePoint(pos, point) {
    const half = point.half > 0 ? point.half : HALF;
    return Math.abs(pos.x - point.x) <= half && Math.abs(pos.z - point.z) <= half;
}

// Segment vs XZ box so a fast frame cannot skip through the region.
function crossesPoint(from, to, point) {
    if (to !== null && insidePoint(to, point)) return true;
    if (from === null || to === null) return false;
    const half = point.half > 0 ? point.half : HALF;
    const minX = point.x - half;
    const maxX = point.x + half;
    const minZ = point.z - half;
    const maxZ = point.z + half;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    let t0 = 0;
    let t1 = 1;
    function clip(p, q) {
        if (Math.abs(p) < 1e-8) return q >= 0;
        const r = q / p;
        if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
        }
        return true;
    }
    return clip(-dx, from.x - minX) && clip(dx, maxX - from.x)
        && clip(-dz, from.z - minZ) && clip(dz, maxZ - from.z);
}

function goldTimeFor(name) {
    if (state.gold === null || !Array.isArray(state.gold.splits)) return null;
    for (let i = 0; i < state.gold.splits.length; i++) {
        if (state.gold.splits[i].name === name) return state.gold.splits[i].time;
    }
    return null;
}

function goldSegmentFor(name) {
    if (state.gold === null || !Array.isArray(state.gold.splits)) return null;
    let prev = 0;
    for (let i = 0; i < state.gold.splits.length; i++) {
        const s = state.gold.splits[i];
        const seg = typeof s.segment === 'number' ? s.segment : s.time - prev;
        if (s.name === name) return seg;
        prev = s.time;
    }
    return null;
}

function pushSplit(name, time) {
    const run = state.run;
    if (run === null || run.hit[name]) return false;
    const start = typeof run.segmentStart === 'number' ? run.segmentStart : 0;
    const segment = Math.max(0, time - start);
    run.hit[name] = true;
    run.splits.push({ name, time, segment });
    run.time = time;
    run.segmentStart = time;
    return true;
}

function segmentTime() {
    if (state.run === null) return 0;
    if (state.frozen || state.run.finished) {
        const last = state.run.splits.length === 0
            ? null : state.run.splits[state.run.splits.length - 1];
        return last !== null && typeof last.segment === 'number' ? last.segment : 0;
    }
    const t = level.runTimer();
    const start = typeof state.run.segmentStart === 'number' ? state.run.segmentStart : 0;
    return Math.max(0, t - start);
}

function manualSplit() {
    if (state.frozen) return false;
    if (!level.inLevel() || !level.started() || level.complete()) return false;
    const n = state.run.splits.filter(s => s.name.indexOf('Split') === 0).length + 1;
    const ok = pushSplit(`Split ${n}`, level.runTimer());
    if (ok) log.info(`split ${n}  ${fmtTime(level.runTimer())}`, 'split');
    return ok;
}

function placePoint(name) {
    const p = ball.position();
    if (p === null) return null;
    loadLevel(level.levelNumber());
    const label = name || `Point ${state.points.length + 1}`;
    const point = { name: label, x: p.x, y: p.y, z: p.z, half: HALF };
    state.points.push(point);
    if (state.run !== null) state.run.inside[label] = true;
    persist();
    log.info(`split point ${label} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}  ±${HALF}`, 'split');
    return point;
}

function removeLastPoint() {
    loadLevel(level.levelNumber());
    if (state.points.length === 0) return false;
    const gone = state.points.pop();
    persist();
    log.info(`removed split point ${gone.name}`, 'split');
    return true;
}

function clearPoints() {
    loadLevel(level.levelNumber());
    const n = state.points.length;
    state.points = [];
    persist();
    log.info(`cleared ${n} split point(s)`, 'split');
    return n;
}

function clearGold() {
    loadLevel(level.levelNumber());
    state.gold = null;
    resetRun();
    persist();
    log.info('cleared TAS gold and current split times', 'split');
}

function resetOnDeath() { return !!state.resetOnDeath; }

function setResetOnDeath(on) {
    state.resetOnDeath = !!on;
    return state.resetOnDeath;
}

function unhitFrom(name) {
    const run = state.run;
    if (run === null) return;
    let idx = -1;
    for (let i = 0; i < state.points.length; i++) {
        if (state.points[i].name === name) { idx = i; break; }
    }
    const drop = {};
    if (idx >= 0) {
        for (let i = idx; i < state.points.length; i++) drop[state.points[i].name] = true;
    } else {
        drop[name] = true;
    }
    run.splits = run.splits.filter(s => !drop[s.name]);
    Object.keys(drop).forEach(n => {
        delete run.hit[n];
        delete run.inside[n];
        delete run.exitArm[n];
    });
}

// The slide has landed. Arm the box so it stamps only after the ball leaves.
function arriveSlide() {
    const name = state.pendingSlide;
    state.pendingSlide = null;
    if (name === null || state.run === null) return;
    let point = null;
    for (let i = 0; i < state.points.length; i++) {
        if (state.points[i].name === name) { point = state.points[i]; break; }
    }
    if (point === null) return;
    const pos = ball.position();
    if (pos === null) return;
    const dx = pos.x - point.x;
    const dz = pos.z - point.z;
    if (dx * dx + dz * dz > 36) return;
    const y = isFinite(point.y) ? point.y : pos.y;
    state.ignoreHits = 8;
    state.lastPos = { x: point.x, y, z: point.z };
    unhitFrom(point.name);
    state.run.inside[point.name] = true;
    state.run.exitArm[point.name] = true;
}

// N / NEXT SPLIT. Slide up, across, then down, the same path as SLIDE TO.
// A raw teleport drops through the floor because the broadphase never sees
// the ball cross the ground. The box arms only once the slide arrives.
function teleportToNext() {
    loadLevel(level.levelNumber());
    if (state.points.length === 0) return { ok: false, reason: 'no split points' };
    if (!ball.levelLoaded()) return { ok: false, reason: 'no ball' };
    const i = ((state.teleportIndex % state.points.length) + state.points.length) % state.points.length;
    const point = state.points[i];
    state.teleportIndex = i + 1;
    const y = isFinite(point.y) ? point.y : 0;
    const ok = ball.slideTo(point.x, y, point.z);
    if (!ok) return { ok: false, point, reason: 'no ball' };
    state.pendingSlide = point.name;
    state.ignoreHits = 8;
    if (state.run === null || state.frozen) beginRun();
    try { frame.syncHot(); } catch (err) { /* */ }
    log.info(`sliding to ${point.name}  (stamps when you leave)`, 'split');
    return { ok: true, point, reason: null };
}

function completionIsWarp() {
    if (deathwarp.autoOn()) return true;
    const pending = warplog.state.pending;
    if (pending !== null && pending.entry && pending.entry.warp) return true;
    if (warplog.state.voidSpent && level.runTimer() < 2) return true;
    return false;
}

function finishRun() {
    if (state.run === null) state.run = emptyRun();
    if (state.run.finished) return;
    const time = level.runTimer();
    pushSplit(FINISH_NAME, time);
    state.run.time = time;
    state.run.finished = true;
    state.frozen = true;

    if (completionIsWarp()) {
        log.info(`finish ${fmtTime(time)}  (warp / probe - not a TAS gold)`, 'split');
        try {
            if (!deathwarp.autoOn()) {
                require('./achievements').noteWarp(state.level, time);
            }
        } catch (err) { /* */ }
        return;
    }

    let beatAllGold = false;
    if (state.points.length >= 2 && state.gold !== null && Array.isArray(state.gold.splits)
        && state.gold.splits.length >= 3) {
        beatAllGold = true;
        for (let i = 0; i < state.gold.splits.length; i++) {
            const name = state.gold.splits[i].name;
            let nowT = null;
            for (let j = 0; j < state.run.splits.length; j++) {
                if (state.run.splits[j].name === name) nowT = state.run.splits[j].time;
            }
            const oldT = goldTimeFor(name);
            if (nowT === null || oldT === null || nowT >= oldT - 0.001) beatAllGold = false;
        }
    }
    try {
        require('./achievements').noteFinish({
            level: state.level, time, warp: false, beatAllGold,
        });
    } catch (err) { /* */ }

    const better = state.gold === null || time < state.gold.time;
    if (better) {
        state.gold = {
            time,
            splits: state.run.splits.map(s => ({
                name: s.name, time: s.time, segment: s.segment,
            })),
        };
        persist();
        log.info(`new TAS gold ${fmtTime(time)}`, 'split');
    }
}

function rows() {
    const run = state.run === null ? emptyRun() : state.run;
    const list = run.splits.slice();
    const finished = run.finished || state.frozen || level.complete();
    if (finished && !run.hit[FINISH_NAME]) {
        const t = run.time > 0 ? run.time : level.runTimer();
        list.push({ name: FINISH_NAME, time: t });
    }
    return list.map(s => {
        const gold = goldTimeFor(s.name);
        const goldSeg = goldSegmentFor(s.name);
        const delta = gold === null ? null : s.time - gold;
        const segment = typeof s.segment === 'number' ? s.segment : null;
        const segmentDelta = goldSeg === null || segment === null ? null : segment - goldSeg;
        return {
            name: s.name,
            time: s.time,
            segment,
            gold,
            goldSeg,
            delta,
            segmentDelta,
            ahead: delta !== null && delta < -0.005,
            behind: delta !== null && delta > 0.005,
        };
    });
}

function tick() {
    try {
        const m = require('./macro').state.mode;
        if (m === 'playing' || m === 'arming' || m === 'lingering') return;
    } catch (err) { /* */ }
    const n = level.levelNumber();
    const inLevel = level.inLevel();
    const started = level.started();
    const complete = level.complete();

    // levelNumber increments on win before the scene unloads. Stay on this
    // level's split file until the finish screen is actually gone.
    if (inLevel && n >= 0 && !complete && !state.frozen) loadLevel(n);
    else if (inLevel && n >= 0 && state.level === null) loadLevel(n);

    if (!inLevel && !complete) {
        state.pendingSlide = null;
        if (state.frozen || state.lastInLevel) resetRun();
        state.lastComplete = false;
        state.lastStarted = false;
        state.lastInLevel = false;
        state.lastDeaths = 0;
        state.lastPos = null;
        return;
    }
    state.lastInLevel = inLevel;

    if (complete && !state.lastComplete) finishRun();
    state.lastComplete = complete;
    if (complete) return;

    // Finish freezes the overlay. A reset / new playthrough has to thaw it
    // or the segment clock keeps the last gold time.
    if (state.frozen) beginRun();

    if (started && !state.lastStarted) beginRun();
    if (!started && state.lastStarted) beginRun();
    state.lastStarted = started;

    if (state.run !== null && started) {
        const t = level.runTimer();
        if (state.run.time > 0.4 && t + 0.2 < state.run.time) beginRun();
    }

    const deaths = warplog.state.deaths || 0;
    if (deaths < state.lastDeaths) state.lastDeaths = deaths;
    if (deaths > state.lastDeaths) {
        state.lastDeaths = deaths;
        if (state.resetOnDeath && !state.frozen) beginRun();
    }

    if (!started || state.frozen || state.run === null) {
        state.lastPos = null;
        return;
    }
    if (ball.moving()) {
        state.ignoreHits = 4;
        return;
    }
    if (state.pendingSlide !== null) {
        arriveSlide();
        try { frame.syncHot(); } catch (err) { /* */ }
    }
    if (state.points.length === 0) {
        state.run.time = level.runTimer();
        state.lastPos = null;
        return;
    }

    const pos = ball.position();
    if (pos === null) return;
    const t = level.runTimer();
    state.run.time = t;

    if (state.ignoreHits > 0) {
        state.ignoreHits -= 1;
        state.lastPos = { x: pos.x, y: pos.y, z: pos.z };
        for (let i = 0; i < state.points.length; i++) {
            const point = state.points[i];
            if (insidePoint(pos, point)) state.run.inside[point.name] = true;
        }
        return;
    }

    const prev = state.lastPos;
    for (let i = 0; i < state.points.length; i++) {
        const point = state.points[i];
        const nowIn = crossesPoint(prev, pos, point);
        if (!nowIn) {
            const wasIn = !!state.run.inside[point.name];
            const arm = !!state.run.exitArm[point.name];
            state.run.inside[point.name] = false;
            if (arm && wasIn && !state.run.hit[point.name]) {
                delete state.run.exitArm[point.name];
                if (pushSplit(point.name, t)) {
                    log.info(`split ${point.name}  ${fmtTime(t)}  (left box)`
                        + `  seg ${fmtTime(state.run.splits[state.run.splits.length - 1].segment)}`,
                        'split');
                }
            }
            continue;
        }
        if (state.run.exitArm[point.name]) {
            state.run.inside[point.name] = true;
            continue;
        }
        if (state.run.inside[point.name] || state.run.hit[point.name]) {
            state.run.inside[point.name] = true;
            continue;
        }
        state.run.inside[point.name] = true;
        if (pushSplit(point.name, t)) {
            log.info(`split ${point.name}  ${fmtTime(t)}  seg ${fmtTime(state.run.splits[state.run.splits.length - 1].segment)}`, 'split');
        }
    }
    state.lastPos = { x: pos.x, y: pos.y, z: pos.z };
}

function install() {
    if (state.installed) return true;
    frame.onAfterFrame(log.guard('splits.tick', tick), 'level');
    state.installed = true;
    return true;
}

function setShowOnMap(on) {
    state.showOnMap = !!on;
}

module.exports = {
    state, install, tick, fmtTime, fmtDelta, rows,
    manualSplit, placePoint, removeLastPoint, clearPoints, clearGold,
    resetOnDeath, setResetOnDeath, teleportToNext,
    setShowOnMap, segmentTime, HALF, FINISH_NAME,
};
