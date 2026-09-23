// Frame rewind. Bullet has no reverse integrator — see README.
// Snapshots are live only, and only while the ball is actually in play.

const mem = require('../core/mem');
const ball = require('../game/ball');
const scene = require('../game/scene');
const frame = require('../game/frame');
const level = require('../game/level');
const log = require('../core/log');

const RB = mem.RB;

// 2 min of undo, so a whole CONTINUE replay can be walked back. Snaps are
// ~0.5KB of plain numbers now; the old byte-array ones at 7200 were a GC bomb.
const MAX = 7200;

const GLOBALS = [
    { name: 'cameraYaw', kind: 'f32' },
    { name: 'runTimer', kind: 'f32' },
    { name: 'tiltSteer', kind: 'f32' },
    { name: 'tiltThrust', kind: 'f32' },
    { name: 'buttonA', kind: 'u8' },
    { name: 'buttonB', kind: 'u8' },
    { name: 'flashState', kind: 'u8' },
];

// Instant teleports bigger than this scramble Bullet's dynamic tree — the
// start pad then has no contact and you fall through. Slide via the saved
// hops, then relink like ResetPlayer.
const SLIDE_UNITS = 4;

const state = {
    history: [],
    sceneKey: null,
    lastError: null,
    lastOp: 'idle',
    wasStarted: false,
    wasIntro: false,
    idleLogged: false,
    captureLogged: false,
};

function ptrOk(p) {
    if (p === null || p === undefined) return false;
    try {
        const n = ptr(p);
        if (n.isNull()) return false;
        if (n.compare(ptr('0x10000')) < 0) return false;
        n.readU8();
        return true;
    } catch (err) {
        return false;
    }
}

function readGlobal(entry) {
    const p = mem.global(entry.name);
    return entry.kind === 'f32' ? p.readFloat() : p.readU8();
}

function writeGlobal(entry, value) {
    if (entry.kind === 'f32' && !isFinite(value)) return;
    const p = mem.global(entry.name);
    if (entry.kind === 'f32') p.writeFloat(value);
    else p.writeU8(value);
}

function recIndex() {
    try {
        const macro = require('./macro');
        if (macro.state.mode === 'playing') return macro.state.cursor | 0;
        return macro.state.frames.length | 0;
    } catch (err) {
        return frame.state.frame | 0;
    }
}

function fmtPos(p) {
    if (p === null || p === undefined || !mem.finite3(p)) return '?';
    return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}

function kickDraw() {
    const view = frame.state.view;
    if (view === null) return;
    try { new ObjC.Object(view).renderGameFrame(); } catch (err) { /* */ }
}

function readXf(p) {
    return {
        r0: mem.readVec3(p),
        r1: mem.readVec3(p.add(16)),
        r2: mem.readVec3(p.add(32)),
        o: mem.readVec3(p.add(48)),
    };
}

function writeXf(p, xf) {
    if (xf === null || xf === undefined) return;
    mem.writeVec3(p, xf.r0.x, xf.r0.y, xf.r0.z);
    mem.writeVec3(p.add(16), xf.r1.x, xf.r1.y, xf.r1.z);
    mem.writeVec3(p.add(32), xf.r2.x, xf.r2.y, xf.r2.z);
    mem.writeVec3(p.add(48), xf.o.x, xf.o.y, xf.o.z);
}

function captureBody(model) {
    const rb = scene.rigidBodyOf(model);
    if (!ptrOk(rb)) return null;
    const origin = mem.readVec3(rb.add(RB.origin));
    if (!mem.finite3(origin)) return null;
    let flags = 0;
    try { flags = rb.add(RB.collisionFlags).readS32(); } catch (err) { flags = 0; }
    return {
        index: null,
        origin,
        lin: mem.readVec3(rb.add(RB.linearVelocity)),
        ang: mem.readVec3(rb.add(RB.angularVelocity)),
        xf: readXf(rb.add(RB.worldTransform)),
        flags,
    };
}

function restoreBody(model, snap, relink) {
    const rb = scene.rigidBodyOf(model);
    if (!ptrOk(rb) || snap.origin === undefined) return false;
    ball.bumpRevision(rb);
    if (snap.flags !== undefined) {
        try { rb.add(RB.collisionFlags).writeS32(snap.flags); } catch (err) { /* */ }
    }
    writeXf(rb.add(RB.worldTransform), snap.xf);
    mem.writeVec3(rb.add(RB.origin), snap.origin.x, snap.origin.y, snap.origin.z);
    mem.writeVec3(rb.add(RB.interpolationOrigin), snap.origin.x, snap.origin.y, snap.origin.z);
    if (snap.lin) mem.writeVec3(rb.add(RB.linearVelocity), snap.lin.x, snap.lin.y, snap.lin.z);
    if (snap.ang) mem.writeVec3(rb.add(RB.angularVelocity), snap.ang.x, snap.ang.y, snap.ang.z);
    try { rb.add(RB.activationState).writeS32(1); } catch (err) { /* */ }
    try { rb.add(RB.totalForce).writeFloat(0); } catch (err) { /* */ }
    const ms = rb.add(RB.motionState).readPointer();
    if (ptrOk(ms) && snap.xf) writeXf(ms.add(0x10), snap.xf);
    const t = scene.transformOf(model);
    if (ptrOk(t) && snap.xf) writeXf(t, snap.xf);
    if (mem.finite3(snap.origin)) {
        try { ball.inflateToward(rb, mem.aabbAround(snap.origin, 4)); } catch (err) { /* */ }
    }
    ball.activate(rb);
    // Relink is the ResetPlayer path and is only safe for the ball. Doing it
    // to a barrel/plank drops its static contacts and it falls through the floor.
    if (relink && snap.index === -1) {
        try { ball.relinkModel(model); } catch (err) { /* */ }
    }
    return true;
}

function inPlayable() {
    if (!level.inLevel() || level.inMainMenu()) return false;
    if (level.restartPending()) return false;
    // Intro still simulates moving scenery. RECORD must snapshot it so -N
    // can walk back through the fly-around instead of only the sit-on-pad.
    if (!level.introPlaying() && !level.started() && !level.inPlay()) return false;
    const rb = ball.rigidBody();
    if (!ptrOk(rb)) return false;
    const p = ball.physicsPosition();
    return mem.finite3(p);
}

// Ball + things you can knock (inverseMass > 0). Not kinematic scenery or
// vertex-anim platforms — those are a shared clock, and copying them every
// frame via Frida is what took 22ms and crashed RECORD on busy levels.
const CAPTURE_MAX = 8;
const SETUP_FRAMES = 30; // load-time jiggle is not a knock
const MOVE_EPS2 = 0.04 * 0.04;
const SPEED_EPS2 = 0.08 * 0.08;

const movers = {
    setupLeft: 0,
    rest: {},
    active: {},
};

function vel2(v) {
    if (!v || !isFinite(v.x)) return 0;
    return v.x * v.x + v.y * v.y + v.z * v.z;
}

function dist2(a, b) {
    if (!a || !b) return 0;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function bodyWoke(item, rest) {
    if (!rest || !rest.origin) return false;
    const rb = scene.rigidBodyOf(item.model);
    if (!ptrOk(rb)) return false;
    const origin = mem.readVec3(rb.add(RB.origin));
    if (dist2(origin, rest.origin) > MOVE_EPS2) return true;
    const lin = mem.readVec3(rb.add(RB.linearVelocity));
    if (vel2(lin) > SPEED_EPS2) return true;
    const ang = mem.readVec3(rb.add(RB.angularVelocity));
    return vel2(ang) > SPEED_EPS2;
}

function rememberRest(item) {
    const snap = captureBody(item.model);
    if (snap === null) return;
    movers.rest[item.index] = {
        origin: snap.origin,
        lin: snap.lin,
        ang: snap.ang,
        xf: snap.xf,
        flags: snap.flags,
    };
}

function resetMovers() {
    movers.setupLeft = SETUP_FRAMES;
    movers.rest = {};
    movers.active = {};
}

function captureItems() {
    const items = [];
    try {
        const ballPtr = mem.global('ball').readPointer();
        if (!ballPtr.isNull()) items.push({ index: -1, model: ballPtr, name: 'ball' });
    } catch (err) { /* */ }

    const dyn = scene.dynamics();
    if (movers.setupLeft > 0) {
        for (let i = 0; i < dyn.length; i++) rememberRest(dyn[i]);
        movers.setupLeft -= 1;
        if (movers.setupLeft === 0) {
            log.debug('rest poses locked - movables stored only after they move', 'rewind');
        }
        return items;
    }

    for (let i = 0; i < dyn.length && items.length < CAPTURE_MAX; i++) {
        const it = dyn[i];
        if (movers.rest[it.index] === undefined) rememberRest(it);
        if (!movers.active[it.index]) {
            try {
                if (bodyWoke(it, movers.rest[it.index])) {
                    movers.active[it.index] = it.name || '?';
                    log.debug(`tracking ${movers.active[it.index]} (moved)`, 'rewind');
                }
            } catch (err) { /* */ }
        }
        if (movers.active[it.index]) items.push(it);
    }
    return items;
}

function capture() {
    try {
        if (!require('../core/budget').rewindOn()) return false;
    } catch (err) { /* */ }
    if (!inPlayable()) return false;
    const items = captureItems();
    if (!state.captureLogged) {
        state.captureLogged = true;
        log.debug(`capturing ${items.length} body(ies): `
            + items.map(it => it.name || '?').join(', '));
    }
    const bodies = [];
    for (let i = 0; i < items.length; i++) {
        try {
            const snap = captureBody(items[i].model);
            if (snap === null) continue;
            snap.index = items[i].index;
            bodies.push(snap);
        } catch (err) { /* skip one bad node */ }
    }
    if (bodies.length === 0) return false;
    const globals = {};
    for (let i = 0; i < GLOBALS.length; i++) {
        try { globals[GLOBALS[i].name] = readGlobal(GLOBALS[i]); } catch (err) { /* */ }
    }
    state.history.push({
        bodies,
        globals,
        frame: frame.state.frame,
        rec: recIndex(),
        playable: true,
    });
    let cap = MAX;
    try {
        const macro = require('./macro');
        if (macro.state.mode === 'playing' && !macro.continueCapturing()) cap = 480;
    } catch (err) { /* */ }
    if (state.history.length > cap + 80) {
        state.history = state.history.slice(state.history.length - cap);
    }
    return true;
}

function originOf(snap) {
    return snap && snap.bodies && snap.bodies[0] ? snap.bodies[0].origin : null;
}

function dist3(a, b) {
    if (!a || !b || !mem.finite3(a) || !mem.finite3(b)) return 0;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function restore(snap, options) {
    const opts = options || {};
    if (snap === null || snap === undefined || !snap.playable) return false;
    if (!inPlayable()) {
        state.lastError = 'not in play';
        return false;
    }
    const byIndex = {};
    try {
        const ballPtr = mem.global('ball').readPointer();
        if (!ballPtr.isNull()) byIndex[-1] = ballPtr;
    } catch (err) { /* */ }
    try {
        const dyn = scene.dynamics();
        for (let i = 0; i < dyn.length; i++) byIndex[dyn[i].index] = dyn[i].model;
    } catch (err) { /* */ }

    const present = {};
    let restored = 0;
    for (let i = 0; i < snap.bodies.length; i++) {
        const body = snap.bodies[i];
        present[body.index] = true;
        const model = byIndex[body.index];
        if (model === undefined) continue;
        try {
            if (restoreBody(model, body, body.index === -1)) restored += 1;
        } catch (err) {
            log.warn(`rewind restore body ${body.index}: ${err.message}`, 'macro');
        }
    }
    const keys = Object.keys(movers.active);
    for (let i = 0; i < keys.length; i++) {
        const idx = keys[i];
        if (present[idx] || idx === '-1') continue;
        delete movers.active[idx];
        const rest = movers.rest[idx];
        const model = byIndex[idx];
        if (rest && model !== undefined) {
            try { restoreBody(model, rest, false); } catch (err) { /* */ }
        }
    }
    for (let i = 0; i < GLOBALS.length; i++) {
        const g = GLOBALS[i];
        if (snap.globals[g.name] === undefined) continue;
        try { writeGlobal(g, snap.globals[g.name]); } catch (err) { /* */ }
    }
    const pos = originOf(snap);
    if (!opts.quiet) {
        log.info(`rewind restored ${restored}/${snap.bodies.length} bodies rec=${snap.rec}`
            + ` at ${fmtPos(pos)}`, 'macro');
        kickDraw();
    }
    return restored > 0;
}

function restoreChain(snaps, fromSnap) {
    if (!snaps || snaps.length === 0) return false;
    const target = snaps[snaps.length - 1];
    const travel = dist3(originOf(fromSnap), originOf(target));
    const crossedVoid = (function () {
        const a = originOf(fromSnap);
        const b = originOf(target);
        // Real void is ~-22. Crossing y=0 is just a hop off a ramp.
        return a && b && ((a.y < -8) !== (b.y < -8));
    }());
    const needSlide = travel > SLIDE_UNITS || crossedVoid;
    if (!needSlide) {
        return restore(target, { relink: travel > 1.5 });
    }
    log.info(`rewind slide ${snaps.length} hops ${travel.toFixed(1)}u`
        + (crossedVoid ? ' (crossed void)' : ''), 'macro');
    for (let i = 0; i < snaps.length - 1; i++) {
        restore(snaps[i], { quiet: true });
    }
    return restore(target, { relink: true });
}

function reset(reason) {
    try { scene.invalidateDynamics(); } catch (err) { /* */ }
    resetMovers();
    state.captureLogged = false;
    if (state.history.length === 0) {
        if (reason) state.lastOp = `clear ${reason}`;
        return;
    }
    state.history = [];
    state.captureLogged = false;
    state.lastOp = `clear ${reason}`;
    if (reason) log.info(`rewind cleared (${reason})`, 'macro');
}

function snapsKept() {
    try {
        if (!require('../core/budget').rewindOn()) return false;
    } catch (err) { /* */ }
    if (frame.state.paused) return true;
    try {
        const macro = require('./macro').state;
        // Undo is for editing while RECORD (or paused after CONTINUE lands).
        // Capturing through a whole CONTINUE replay balloons RSS and jetsams
        // mid-tip — the take looked "non-deterministic" when the process died.
        if (macro.mode === 'recording') return true;
        if (require('./macro').continueCapturing()) return true;
    } catch (err) { /* */ }
    return false;
}

function onFrame() {
    const scenePtr = mem.global('scene').readPointer();
    const key = scenePtr.isNull() ? null : scenePtr.toString();
    if (key !== state.sceneKey) {
        state.sceneKey = key;
        reset(key === null ? 'left level' : 'new scene');
    }
    const started = level.started();
    const intro = level.introPlaying();
    if ((state.wasStarted && !started) || (intro && !state.wasIntro)) {
        let keep = false;
        try {
            const mode = require('./macro').state.mode;
            keep = mode === 'playing' || mode === 'recording';
        } catch (err) { /* */ }
        if (!keep) reset('level restart');
    }
    state.wasStarted = started;
    state.wasIntro = intro;
    if (!snapsKept()) {
        if (state.history.length) reset('idle');
        if (!state.idleLogged) {
            state.idleLogged = true;
            let forced = false;
            try { forced = !require('../core/budget').rewindOn(); } catch (err) { /* */ }
            console.log(forced
                ? '[aerox-tas] rewind: snaps OFF (SETTINGS)'
                : '[aerox-tas] rewind: snapshots off until RECORD or PAUSE');
        }
        return;
    }
    state.idleLogged = false;
    if (level.restartPending() || !inPlayable()) return;
    if (frame.state.paused && frame.state.pendingFrames <= 0) return;
    try {
        const macro = require('./macro');
        if (macro.state.mode === 'lingering') return;
        if (macro.hooksQuiet() && macro.state.mode !== 'recording'
            && !macro.continueCapturing()) return;
        // Watch-only PLAY / CONTINUE replay: no undo buffer. Capture resumes
        // when CONTINUE lands and mode flips back to recording. REFRESH
        // rebuilds the tail so -N lands on the fresh physics.
        if (macro.state.mode === 'playing' && !macro.continueCapturing()) return;
    } catch (err) { /* */ }
    capture();
}

function depth() { return Math.max(0, state.history.length - 1); }

function applyMacroCursor(rec) {
    try {
        const macro = require('./macro');
        if (macro.state.mode === 'recording') {
            if (rec < macro.state.frames.length) {
                log.info(`rewind trim rec ${macro.state.frames.length} -> ${rec}`, 'macro');
                macro.state.frames.length = rec;
                macro.state.complete = false;
                try { macro.trimGates(rec); } catch (err) { /* */ }
                try { macro.syncPreviousFlags(); } catch (err) { /* */ }
                try { macro.persist('rewind', false); } catch (err) { /* */ }
            }
        }
        if (macro.state.mode === 'playing') {
            macro.state.cursor = Math.max(0, Math.min(rec, macro.state.frames.length));
        }
    } catch (err) { /* */ }
}

function back(n) {
    const steps = n === undefined ? 1 : Math.max(1, n | 0);
    if (state.history.length < 2) {
        state.lastError = 'nothing to rewind (need to be in play first)';
        log.warn(state.lastError, 'macro');
        return false;
    }
    const take = Math.min(steps, state.history.length - 1);
    const snap = state.history[state.history.length - 1 - take];
    if (!snap || !snap.playable) {
        state.lastError = 'would rewind before spawn';
        log.warn(state.lastError, 'macro');
        return false;
    }
    const from = state.history[state.history.length - 1];
    const chain = [];
    for (let i = state.history.length - 2; i >= state.history.length - 1 - take; i--) {
        chain.push(state.history[i]);
    }
    state.lastOp = `back ${take}  ${from ? from.rec : '?'}f -> ${snap.rec}f  ${fmtPos(originOf(snap))}`;
    log.info(state.lastOp, 'macro');
    state.history.splice(state.history.length - take, take);
    const ok = restoreChain(chain, from);
    if (!ok) return false;
    applyMacroCursor(snap.rec | 0);
    frame.setPaused(true);
    return true;
}

function forward(n) {
    try {
        const macro = require('./macro');
        if (macro.shifting()) {
            const ok = macro.shiftStep(n === undefined ? 1 : n);
            state.lastOp = ok
                ? `shift +${n === undefined ? 1 : n} (pending ${macro.shiftDelta()}f)`
                : (macro.state.lastError || 'shift failed');
            if (!ok) state.lastError = macro.state.lastError;
            return ok;
        }
    } catch (err) { /* */ }
    if (!inPlayable()) {
        state.lastError = 'not in play';
        return false;
    }
    frame.setPaused(true);
    frame.advance(n === undefined ? 1 : n);
    state.lastOp = `forward ${n === undefined ? 1 : n}`;
    log.info(state.lastOp, 'macro');
    return true;
}

function step(delta) {
    const d = delta | 0;
    if (d === 0) return true;
    try {
        const macro = require('./macro');
        if (macro.shifting()) {
            if (d > 0) return forward(d);
            const ok = macro.shiftStep(d);
            state.lastOp = ok ? `shift ${d} (pending ${macro.shiftDelta()}f)`
                : (macro.state.lastError || 'shift failed');
            if (!ok) state.lastError = macro.state.lastError;
            return ok;
        }
    } catch (err) { /* */ }
    if (d > 0) return forward(d);

    let macro = null;
    try { macro = require('./macro'); } catch (err) { /* */ }
    if (macro !== null) {
        try { macro.landContinue(`-${-d}`); } catch (err) { /* */ }
    }
    if (macro !== null && macro.busy()) {
        state.lastError = 'still restarting - wait';
        log.warn(state.lastError, 'macro');
        return false;
    }
    const playing = macro !== null && macro.state.mode === 'playing';
    const haveTake = macro !== null && macro.state.frames.length > 0;
    const cur = !haveTake ? (frame.state.frame | 0)
        : playing ? (macro.state.cursor | 0)
        : (macro.state.frames.length | 0);
    const target = Math.max(0, cur + d);

    // -N only walks the undo buffer. It never replays; PLAY / CONTINUE do.
    if (state.history.length < 2) {
        state.lastError = 'nothing to undo here - -N does not replay';
        log.warn(state.lastError, 'macro');
        return false;
    }
    const oldest = state.history[0].rec | 0;
    if (target < oldest) {
        log.info(`-N clamped to undo start ${oldest}f (asked ${target}f)`, 'macro');
    }
    // Snapshots can skip frames (death / respawn). Land on the last one at or
    // before the target, by rec index rather than by count.
    let at = 0;
    for (let i = state.history.length - 1; i >= 0; i--) {
        if ((state.history[i].rec | 0) <= target) { at = i; break; }
    }
    const take = state.history.length - 1 - at;
    if (take <= 0) {
        state.lastError = `already at undo start ${oldest}f`;
        log.warn(state.lastError, 'macro');
        return false;
    }
    return back(take);
}

// CONTINUE replays with no capture. Keep the RECORD snapshots aside so -N
// still reverts earlier segments after it lands.
let stash = null;

function stashForContinue(n) {
    const src = state.history.length ? state.history : (stash || []);
    stash = src.filter(s => (s.rec | 0) <= n);
}

function dropStash() { stash = null; }

function unstash(n) {
    if (stash === null) return 0;
    const kept = stash.filter(s => (s.rec | 0) < n);
    stash = null;
    state.history = kept.concat(state.history.filter(s => (s.rec | 0) >= n));
    return kept.length;
}

function snapshotForRec(rec) {
    for (let i = state.history.length - 1; i >= 0; i--) {
        if ((state.history[i].rec | 0) === rec) return { snap: state.history[i], at: i };
    }
    return null;
}

function jump(rec) {
    const target = Math.max(0, rec | 0);
    try { require('./macro').landContinue(`jump ${target}`); } catch (err) { /* */ }
    const hit = snapshotForRec(target);
    if (hit !== null && hit.snap.playable && inPlayable()) {
        const from = state.history[state.history.length - 1];
        const chain = [];
        for (let i = state.history.length - 2; i >= hit.at; i--) {
            chain.push(state.history[i]);
        }
        if (chain.length === 0) chain.push(hit.snap);
        state.lastOp = `jump snapshot rec=${target}`;
        log.info(state.lastOp, 'macro');
        state.history = state.history.slice(0, hit.at + 1);
        if (!restoreChain(chain, from)) return false;
        applyMacroCursor(target);
        frame.setPaused(true);
        return true;
    }
    try {
        const macro = require('./macro');
        if (macro.state.frames.length === 0) {
            state.lastError = 'no macro frames to seek';
            return false;
        }
        if (target > macro.state.frames.length) {
            state.lastError = `only ${macro.state.frames.length} frames recorded`;
            return false;
        }
        state.lastOp = `replay to ${target}f`;
        log.info(`${state.lastOp} (no snapshot; re-simulating)`, 'macro');
        return macro.seek(target, macro.state.mode === 'recording' || !macro.state.complete);
    } catch (err) {
        state.lastError = err.message;
        return false;
    }
}

function install() {
    frame.onAfterFrame(log.guard('rewind.onFrame', onFrame), 'capture');
}

module.exports = {
    state, install, capture, restore, reset, back, forward, step, jump, depth,
    inPlayable, MAX, stashForContinue, dropStash, unstash,
};
