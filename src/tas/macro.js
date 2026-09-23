// Frame-exact input recording and playback.
//
// A macro is one row per simulated frame:
//
//     [ steer, thrust, buttons, yaw, events ]
//
// steer and thrust are the *final* tiltSteer / tiltThrust globals, sampled after
// the game has computed them. Recording the result rather than the cause is what
// makes this work across input sources: a frame driven by real device tilt, by
// the on-screen pad, or by a paired keyboard all record identically, and on
// playback we reproduce the values by writing the EAGLView accel ivars (see
// game/input.js for why that is exact).
//
// ------------------------------------------------------------ camera panning
//
// Turning in Aerox is done with a thumb on the screen, not with thrust, and the
// camera yaw feeds straight back into the direction force. The row stores the
// yaw physics had just produced. The next frame has to START on that yaw:
// processGameFrame adds this frame's steer on top, then pushes the ball along
// the new facing. Writing this frame's own yaw before the tick turns early.
// Leaving the level's yaw in place aims the jump the wrong way, so the ball
// stays on the pad or drops into the void while the view follows the tape.
//
// ------------------------------------------------------------------- taps
//
// The only taps that change game state are the ones that clear a blocking
// screen: skipping the opening fly-around, and dismissing the "Get Ready!"
// prompt or a mid-run tip. Everything else a touch can do is already covered -
// buttons are in `buttons`, panning is in `yaw`.
//
// So rather than record raw touches, we watch for the transitions themselves
// (introPlaying 1->0, menuFlag 1->0) and replay them by running the same code
// the touch handlers run. See game/level.js.
//
// This matters more than it sounds. The level simulates all through the opening
// fly-around, so moving platforms are already running and the frame you skip on
// decides the state the run begins from. A macro that did not pin that frame
// would desync on any level with moving geometry.
//
// ------------------------------------------------------------- determinism
//
// Recording and playback both restart the level first, so frame 0 is always
// `loadLevel:` finishing. Playback is only frame-exact against a fixed timestep,
// so arming a macro turns that on. Finishing the level stops a recording and
// saves it automatically.

const mem = require('../core/mem');
const log = require('../core/log');
const frame = require('../game/frame');
const input = require('../game/input');
const level = require('../game/level');
const ball = require('../game/ball');
const camera = require('../game/camera');
const ivars = require('../core/ivars');

const BUTTON_A = 1;
const BUTTON_B = 2;

const EVENT_SKIP_INTRO = 1;
const EVENT_DISMISS = 2;

const FILE_VERSION = 3; // frames store f32 bit patterns so JSON cannot drift
const AUTOSAVE_EVERY = 60;
const FINISH_PAD = 90; // extra ticks after the last input so a death-warp finish can draw

let persistAt = 0;
let persistLen = -1;
let persistDirty = false;
let persistTimer = null;
let persistWant = null;
let recordingAtPre = false;
let preTickYaw = NaN;
let playIntroWas = false; // PLAY: was the intro running last tick // cameraYaw after touches, before processGameFrame turns it

const state = {
    mode: 'idle',       // 'idle' | 'arming' | 'recording' | 'playing'
    frames: [],
    cursor: 0,
    loaded: null,       // name this macro was loaded from or saved as
    pinYaw: true,
    smoothCam: true,    // PLAY-only visual orbit; does not write cameraYaw
    // Per-frame physics fingerprint (bodies, broadphase, pairs) for finding
    // RECORD/PLAY divergence. ~5-10ms a frame, so off unless debugging:
    // tas.macro.state.physTrace = true, then RECORD + PLAY.
    physTrace: false,
    continuePauses: true, // CONTINUE only: freeze when the replay runs out
    // Set when a macro was stopped before the finish, so it can be continued.
    resumeState: null,
    complete: false,    // did this macro reach the finish
    autoSaveName: null, // name to save under when the finish is reached
    pendingMode: null,  // what to switch to once the restart lands
    resumeAtEnd: false, // hand control back when the replay runs out
    lingerUntil: 0,     // non-zero while holding the end screen
    lingerWait: 0,      // frames since PLAY ended without a finish
    lingerHold: 0,      // frames the victory screen has been up
    lingerAway: 0,
    playFromStart: false,
    playClean: false,
    playSmoothCam: false,
    fileLevel: null,    // level index stored in the file; PLAY reloads this
    lastError: null,
    seekTo: null,       // pause playback once cursor reaches this
    seekRecord: false,  // then keep recording from there
    awayFrames: 0,
    armedAt: -999,
    skipAt: -1,         // first recorded intro skip; retry until it lands
    dismissAt: -1,      // first recorded Get Ready dismiss
    // Durable event indices. Rewind re-record used to wipe EVENT bits off the
    // tape, so PLAY showed ready=wait and never cleared Get Ready.
    gates: { skip: null, readyDismiss: null, dismiss: [] },
    // Original skip index before any "Shift intro" edit, for revert.
    introSkipBaseline: null,
    framesBaseline: null,  // full frame copy for intro-shift revert
    gatesBaseline: null,
    shift: null,           // { origin, yaw, delta, base... } while nudging platforms
    shiftResync: null,     // the shift, parked while a -N preview replays
    refreshing: false,     // REFRESH PHYSICS replay in progress
    // Set when PAUSE / -N cut a CONTINUE short. The file on disk keeps the
    // full take until a new frame is recorded, so a stray pause loses nothing.
    cutPending: false,
    refreshSpeed: 1,       // speed slider value to put back when it lands
};

// REFRESH / shift preview replay rate. Ticks stay 1/60 each; frame.js lets
// these past the slider's 3/vsync, up to its turbo cap of 8.
const REFRESH_SPEED = 8;

// Previous-frame flags, for spotting the transitions we record as events.
const previous = { intro: false, message: false, ready: false, complete: false };

// Level of the loaded scene, not DAT_levelNumber (a warp or the menus move
// that, and macros listed / saved under the wrong level).
function levelNumber() { return level.loadedLevel(); }

function fmt3(n) {
    const v = +n;
    if (!isFinite(v)) return '?';
    return v.toFixed(4);
}

function tapeFlags() {
    return `dt=${fmt3(frame.state.lastDt)}`
        + ` play=${level.inPlay() ? 1 : 0}`
        + ` menu=${level.messageUp() ? 1 : 0}`
        + ` intro=${level.introPlaying() ? 1 : 0}`
        + ` ready=${level.readyPrompt() ? 1 : 0}`;
}

// The exact row as f32 hex (s.t.y[.preYaw]), so RECOVER FROM TAPE rebuilds
// a take bit for bit. The 4-decimal fields are for reading.
function rawRow(row) {
    const h = v => f32bits(v).toString(16);
    return ` raw=${h(row[0])}.${h(row[1])}.${h(row[3])}`
        + (row.length > 5 && isFinite(row[5]) ? `.${h(row[5])}` : '');
}

function tapeRecord(index, row) {
    try {
        log.tape(`REC ${index} s=${fmt3(row[0])} t=${fmt3(row[1])} b=${row[2] | 0}`
            + ` y=${fmt3(row[3])} e=${row[4] | 0}${rawRow(row)}  ${fmtBall4()}  ${tapeFlags()}`);
    } catch (err) { /* */ }
}

function tapePlay(index, row, live, yaw) {
    try {
        const rs = +row[0] || 0;
        const rt = +row[1] || 0;
        const ry = +row[3] || 0;
        const gs = live && isFinite(live.steer) ? live.steer : 0;
        const gt = live && isFinite(live.thrust) ? live.thrust : 0;
        const gy = isFinite(yaw) ? yaw : 0;
        const gated = level.introPlaying() || level.readyPrompt();
        const miss = (!gated && (Math.abs(rs - gs) > 0.02 || Math.abs(rt - gt) > 0.02))
            || (!level.introPlaying() && isFinite(ry) && Math.abs(ry - gy) > 0.05);
        log.tape(`${miss ? 'MISS' : 'PLAY'} ${index}`
            + ` row=${fmt3(rs)},${fmt3(rt)},${row[2] | 0},${fmt3(ry)},${row[4] | 0}${rawRow(row)}`
            + ` got=${fmt3(gs)},${fmt3(gt)},${fmt3(gy)}  ${fmtBall4()}  ${tapeFlags()}`);
    } catch (err) { /* */ }
}

function fmtBall() {
    try {
        const p = ball.physicsPosition();
        if (p && isFinite(p.x)) {
            return `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
        }
    } catch (err) { /* */ }
    return '?';
}

// Full float precision so two runs can be diffed to the first differing bit.
function fmtBall4() {
    try {
        const p = ball.physicsPosition();
        const v = ball.velocity();
        const w = ball.angularVelocity();
        if (p && isFinite(p.x)) {
            const g = (n) => (+n).toPrecision(9);
            return `p=${g(p.x)},${g(p.y)},${g(p.z)}`
                + (v ? ` v=${g(v.x)},${g(v.y)},${g(v.z)}` : '')
                + (w ? ` w=${g(w.x)},${g(w.y)},${g(w.z)}` : '');
        }
    } catch (err) { /* */ }
    return '?';
}

// Bullet counters that outlive loadLevel differ run to run (game/physics.js).
// Log what the load left, then pin them so frame 0 starts the same every time.
// Console checkpoints so two runs can be compared without the tape file.
function physCheckpoint(i) {
    if (!state.physTrace || i < 100 || i % 100 !== 0) return;
    try { log.info(`chk ${i} ${require('../game/physics').digest()}`, 'macro'); } catch (err) { /* */ }
}

function armPhysics() {
    try { frame.collectGarbage('arm', true); } catch (err) { /* */ }
    const phys = require('../game/physics');
    const before = phys.describe();
    const ok = phys.normalize('arm');
    let bodies = '';
    try { bodies = phys.cleanBodies(); } catch (err) { bodies = `bodies: ${err.message}`; }
    let rebuilt = '';
    try { rebuilt = phys.rebuildBroadphase('arm'); } catch (err) { rebuilt = `rebuild: ${err.message}`; }
    log.debug(`${before}${ok ? '  -> pinned' : '  (not pinned)'}  ${bodies}  ${rebuilt}`, 'macro');
    log.debug(`chk arm ${phys.digest()}`, 'macro');
    phys.dumpWorld('arm', (line) => log.tape(line));
}

// Ball position per frame. RECORD is the reference; with none (a loaded file)
// the first PLAY fills it and later PLAYs compare. Only the first drift and a
// summary reach the console - per-frame lines go to tape.log.
const DRIFT = 0.01;
// dig[i] is the physics fingerprint (bodies + contact pair order) after tick i,
// so PLAY can name the first tick whose physics differs, not just the ball.
const trace = { pts: [], dig: [], src: null, first: -1, max: 0, maxAt: -1, n: 0, digAt: -1,
    fresh: null, freshDig: null };

function physDigest() {
    try { return require('../game/physics').digest(); } catch (err) { return '?'; }
}

function resetTrace() {
    trace.pts = [];
    trace.dig = [];
    trace.src = null;
}

function beginTrace() {
    trace.first = -1;
    trace.max = 0;
    trace.maxAt = -1;
    trace.n = 0;
    trace.digAt = -1;
}

function traceRecord(i) {
    const p = ball.physicsPosition();
    if (!p || !isFinite(p.x)) return;
    trace.pts.length = i;
    trace.pts[i] = [p.x, p.y, p.z];
    trace.dig.length = i;
    if (state.physTrace) trace.dig[i] = physDigest();
    trace.src = 'rec';
}

function tracePlay(i) {
    const p = ball.physicsPosition();
    if (!p || !isFinite(p.x)) return;
    if (state.refreshing && trace.fresh !== null) {
        trace.fresh[i] = [p.x, p.y, p.z];
        if (state.physTrace) trace.freshDig[i] = physDigest();
    }
    const ref = trace.pts[i];
    if (ref === undefined) {
        if (trace.src !== 'rec') {
            trace.pts[i] = [p.x, p.y, p.z];
            if (state.physTrace) trace.dig[i] = physDigest();
            trace.src = 'play';
        }
        return;
    }
    if (state.physTrace && trace.digAt < 0 && trace.dig[i] !== undefined) {
        const now = physDigest();
        if (now !== trace.dig[i]) {
            trace.digAt = i;
            log.info(`trace: physics differs first @${i}f vs ${trace.src}`, 'macro');
            if (trace.dig[i - 1] !== undefined) log.info(`  ${trace.src} @${i - 1}: ${trace.dig[i - 1]}`, 'macro');
            log.info(`  ${trace.src} @${i}: ${trace.dig[i]}`, 'macro');
            log.info(`  play @${i}: ${now}`, 'macro');
        }
    }
    trace.n += 1;
    const dx = p.x - ref[0];
    const dy = p.y - ref[1];
    const dz = p.z - ref[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > trace.max) {
        trace.max = d;
        trace.maxAt = i;
    }
    if (d > DRIFT && trace.first < 0) {
        trace.first = i;
        log.info(`trace: first drift @${i}f d=${d.toFixed(4)} vs ${trace.src}`
            + ` ref=${ref[0].toFixed(3)},${ref[1].toFixed(3)},${ref[2].toFixed(3)}`
            + ` got=${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}  ${tapeFlags()}`, 'macro');
    }
}

function traceSummary() {
    if (trace.n === 0) return;
    log.info(`trace: ${trace.first < 0 ? 'matched' : `drift from ${trace.first}f`}`
        + ` over ${trace.n}f vs ${trace.src}, max d=${trace.max.toFixed(4)} @${trace.maxAt}f`, 'macro');
    trace.n = 0;
}

// -------------------------------------------------------- state snapshots
//
// Save states are byte copies of the ball's rigid body, which is enough to
// resume a partial macro's *ball* but not the level's moving scenery. Continuing
// a macro therefore replays the recorded frames to rebuild the world and only
// uses the snapshot to verify the ball landed where it should.

function snapshot() {
    const model = ball.model();
    if (model === null) return null;
    const rb = model.add(ivars.offsetOf('synNode', 'rigidBody')).readPointer();
    if (rb.isNull()) return null;

    const position = mem.readVec3(rb.add(mem.RB.origin));
    const velocity = mem.readVec3(rb.add(mem.RB.linearVelocity));
    return {
        position, velocity,
        cameraYaw: mem.global('cameraYaw').readFloat(),
        runTimer: level.runTimer(),
    };
}

// -------------------------------------------------------------- capture

function busy() {
    return state.mode === 'arming' || state.mode === 'playing'
        || state.mode === 'lingering'
        || level.restartPending() || level.settling();
}

function wrapTau(a) {
    const tau = Math.PI * 2;
    let x = a % tau;
    if (x < 0) x += tau;
    return x;
}

function shortestDelta(from, to) {
    let d = wrapTau(to) - wrapTau(from);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

const SMOOTH_RATE = 0.08; // once per draw; lower = slower / less jitter

let visualYaw = null;
let visualYawHold = null; // recorded yaw to put back after the draw
let silencingPause = false;
let quietUntil = 0;

function markQuiet(n) {
    const f = frame.state.frame | 0;
    quietUntil = Math.max(quietUntil, f + (n || 90));
}

// Warp / rewind / skins must not walk the scene on the victory tick or the
// first frames after PLAY. That is what crashed the second CLEAN PLAY.
function hooksQuiet() {
    if (state.mode === 'playing' || state.mode === 'arming' || state.mode === 'lingering') {
        return true;
    }
    if ((frame.state.frame | 0) < quietUntil) return true;
    try {
        if (level.complete()) {
            // AUTO PROBE / SEARCH must keep running on the victory tick so they
            // can pin DAT_levelNumber back and reload. A death warp already
            // incremented the index.
            try {
                if (require('./warplog').state.auto) return false;
            } catch (err) { /* */ }
            try {
                if (require('./deathwarp').autoOn()) return false;
            } catch (err) { /* */ }
            return true;
        }
    } catch (err) { /* */ }
    return false;
}

function resetVisualCam() {
    visualYaw = null;
    if (visualYawHold !== null) {
        try { mem.global('cameraYaw').writeFloat(visualYawHold); } catch (err) { /* */ }
        visualYawHold = null;
    }
    try { camera.restoreVisual(); } catch (err) { /* */ }
}

function resetStartYaw() {
    resetVisualCam();
    try {
        const yaw = state.frames.length > 0 && isFinite(state.frames[0][3])
            ? state.frames[0][3] : 0;
        mem.global('cameraYaw').writeFloat(yaw);
        mem.global('checkpointYaw').writeFloat(yaw);
    } catch (err) { /* */ }
}

function visualAllowed() {
    return state.smoothCam && state.mode === 'playing'
        && !level.introPlaying() && !level.complete() && level.inLevel();
}

// View only, and only around the draw. The camera node is rotated; cameraYaw
// stays the value physics just wrote so the next tick cannot drift.
function applyVisualCam() {
    if (!visualAllowed()) {
        resetVisualCam();
        return;
    }
    const recorded = mem.global('cameraYaw').readFloat();
    if (!isFinite(recorded)) return;
    if (visualYaw === null) visualYaw = recorded;
    const delta = shortestDelta(visualYaw, recorded);
    visualYaw = wrapTau(visualYaw + delta * SMOOTH_RATE);
    const leftover = shortestDelta(recorded, visualYaw);
    if (Math.abs(leftover) < 1e-4) return;
    try { camera.applyVisualYaw(leftover); } catch (err) { /* */ }
}

function restoreVisualCam() {
    if (visualYawHold !== null) {
        try { mem.global('cameraYaw').writeFloat(visualYawHold); } catch (err) { /* */ }
        visualYawHold = null;
    }
    try { camera.restoreVisual(); } catch (err) { /* */ }
}

function cleanPlayOn() {
    try { return !!require('../ui/timer').chrome.clean; } catch (err) { return false; }
}

function abortPlayback(reason) {
    if (state.mode !== 'playing' && state.mode !== 'lingering' && state.mode !== 'arming') {
        return;
    }
    input.setOverride(null);
    input.setButton('a', false);
    input.setButton('b', false);
    resetVisualCam();
    markQuiet(90);
    try { log.flushTape(); } catch (err) { /* */ }
    try { frame.stopNativePlay(); } catch (err) { /* */ }
    state.mode = 'idle';
    state.resumeAtEnd = false;
    state.seekTo = null;
    state.seekRecord = false;
    state.pendingMode = null;
    state.lingerUntil = 0;
    state.lingerWait = 0;
    state.lingerHold = 0;
    state.lingerAway = 0;
    endRefresh();
    if (state.shiftResync) endShiftResync(false);
    try { require('./rewind').reset('play aborted'); } catch (err) { /* */ }
    try { require('../ui/timer').endClean(); } catch (err) { /* */ }
    if (reason) log.info(reason, 'macro');
}

function onTasPause(paused) {
    if (!paused || silencingPause) return;
    if (state.mode === 'playing' && state.resumeAtEnd) {
        landContinue('pause');
        return;
    }
    if (state.seekTo !== null || state.resumeAtEnd) return;
    if (!cleanPlayOn()) return;
    if (state.mode === 'playing' || state.mode === 'lingering' || state.mode === 'arming') {
        abortPlayback('PLAY stopped - pause');
        try { level.dismissPauseMenu(); } catch (err) { /* */ }
    }
}

let pausePoll = 0;

function watchNativePause() {
    if (state.resumeAtEnd || state.seekTo !== null) return;
    if (state.mode !== 'playing' && state.mode !== 'lingering' && state.mode !== 'arming') {
        return;
    }
    // ObjC menuManager/currentMenu every PLAY frame was ~3.5ms and leaked wrappers.
    if (state.mode === 'playing') {
        pausePoll += 1;
        if ((pausePoll & 7) !== 0) return;
    }
    try {
        if (!level.pausedInGame()) return;
    } catch (err) { return; }
    // loadLevel leaves currentMenu=6. Treating that as a user pause aborted
    // PLAY and printed "PLAY stopped - game pause" on a clean take.
    try { level.dismissPauseMenu(); } catch (err) { /* */ }
}

function endLinger(reason) {
    if (state.mode !== 'lingering' && state.lingerUntil === 0) return;
    try { frame.stopNativePlay(); } catch (err) { /* */ }
    state.mode = 'idle';
    state.pendingMode = null;
    state.lingerUntil = 0;
    state.lingerWait = 0;
    state.lingerHold = 0;
    state.lingerAway = 0;
    markQuiet(180);
    try { require('./rewind').reset('play ended'); } catch (err) { /* */ }
    try { require('./warplog').resetLoad('play ended'); } catch (err) { /* */ }
    try { require('../ui/timer').endClean(); } catch (err) { /* */ }
    if (reason) log.info(reason, 'macro');
}

function tickLinger() {
    if (state.mode !== 'lingering') return;
    watchNativePause();
    if (state.mode !== 'lingering') return;
    if (frame.state.paused) {
        silencingPause = true;
        try { frame.setPaused(false); } catch (err) { /* */ }
        silencingPause = false;
    }
    if (level.complete()) {
        if (state.lingerHold === 0) {
            state.complete = true;
            log.info('PLAY finish appeared - holding the timer screen', 'macro');
        }
        state.lingerHold += 1;
        state.lingerAway = 0;
        if (state.lingerHold >= 75) {
            endLinger('PLAY finish screen held - UI back');
        }
        return;
    }
    if (!level.inLevel() || level.inMainMenu()) {
        state.lingerAway += 1;
        // Death-warp finish can drop inLevel for a moment before complete.
        if (state.lingerAway >= 45) {
            endLinger('PLAY left the level - UI back');
            return;
        }
    } else {
        state.lingerAway = 0;
    }
    state.lingerWait += 1;
    if (state.lingerWait >= 180) {
        endLinger('PLAY linger timed out - UI back');
    }
}

function sampleAfterFrame() {
    // Only sample if RECORD was already on before this tick. CONTINUE lands
    // mid-post-hook and used to append a ghost frame. The pendingFrames
    // guard that replaced it dropped the last +N tick (10 physics, 9 samples)
    // so every splice after rewind PLAY'd short and fell.
    if (!recordingAtPre) return;
    if (state.mode !== 'recording') return;
    if (state.shift) return;
    if (busy()) return;

    // loadLevel / Get Ready flicker inLevel and mainMenu. That used to STOP
    // the take at 0f and auto-save an empty "P".
    const gone = !level.inLevel();
    const justArmed = (frame.state.frame - state.armedAt) < 90;
    if (gone) {
        state.awayFrames += 1;
        if (justArmed || state.awayFrames < 45) return;
        const frames = state.frames.length;
        stop();
        log.warn(`left the level after ${frames} frames; take kept`
            + (state.autoSaveName ? ` (saved ${state.autoSaveName})` : ' - SAVE to keep it'),
            'macro');
        return;
    }
    state.awayFrames = 0;

    const intro = level.introPlaying();
    let message = level.messageUp();
    const finished = level.complete();

    let events = 0;
    if (previous.intro && !intro) events |= EVENT_SKIP_INTRO;
    if (previous.message && !message) events |= EVENT_DISMISS;

    const index = state.frames.length;
    // Rewind past Get Ready then forward again often leaves menuFlag already
    // clear, so the transition never fires. Re-stamp the sticky ready dismiss.
    if (state.gates.readyDismiss === index && (events & EVENT_DISMISS) === 0) {
        events |= EVENT_DISMISS;
        if (message) {
            try { level.dismissMessage(frame.state.view); } catch (err) { /* */ }
            message = false;
        }
    }

    const ready = level.readyPrompt();
    if (previous.ready && !ready && (events & EVENT_DISMISS) === 0) {
        events |= EVENT_DISMISS;
    }

    const live = input.current();
    const row = [
        live.steer,
        live.thrust,
        (live.buttonA ? BUTTON_A : 0) | (live.buttonB ? BUTTON_B : 0),
        mem.global('cameraYaw').readFloat(),
        events,
    ];
    // Pan (touchesMoved) lands between ticks; tilt steer turns inside the tick.
    // Column 5 is the yaw the tick started on, so PLAY can reproduce both.
    if (isFinite(preTickYaw)) row.push(preTickYaw);
    state.frames.push(row);
    state.cutPending = false;
    noteGate(index, events);
    traceRecord(index);
    tapeRecord(index, row);
    physCheckpoint(index);
    if ((events & EVENT_SKIP_INTRO) !== 0) {
        log.info(`RECORD skip intro @${index}f ${fmtBall()}`, 'macro');
    }
    if ((events & EVENT_DISMISS) !== 0) {
        log.info(`RECORD dismiss @${index}f ${fmtBall()}`, 'macro');
    }

    previous.intro = intro;
    previous.message = message;
    previous.ready = ready;

    if (state.frames.length > 0 && state.frames.length % AUTOSAVE_EVERY === 0) {
        persist('checkpoint', false);
    }

    // Crossing the finish ends the run, so it ends the recording.
    if (finished && !previous.complete) {
        state.complete = true;
        state.resumeState = null;
        const n = state.frames.length;
        const name = state.autoSaveName;
        stop();
        if (name !== null) {
            persist('finish', false);
            console.log(`[aerox-tas] run complete in ${n} frames; saving ${name}`);
        } else {
            console.log(`[aerox-tas] run complete in ${n} frames `
                + '(not saved - give it a name on the MACRO tab)');
        }
    }
    previous.complete = finished;
}

function firstEventFrame(mask) {
    for (let i = 0; i < state.frames.length; i++) {
        if (((state.frames[i][4] || 0) & mask) !== 0) return i;
    }
    return -1;
}

function allEventFrames(mask) {
    const out = [];
    for (let i = 0; i < state.frames.length; i++) {
        if (((state.frames[i][4] || 0) & mask) !== 0) out.push(i);
    }
    return out;
}

function cloneGates(g) {
    return {
        skip: g.skip === null || g.skip === undefined ? null : (g.skip | 0),
        readyDismiss: g.readyDismiss === null || g.readyDismiss === undefined
            ? null : (g.readyDismiss | 0),
        dismiss: (g.dismiss || []).slice(),
    };
}

function rebuildGatesFromFrames() {
    const skip = firstEventFrame(EVENT_SKIP_INTRO);
    const dismiss = allEventFrames(EVENT_DISMISS);
    state.gates.skip = skip >= 0 ? skip : state.gates.skip;
    state.gates.dismiss = dismiss.length ? dismiss : state.gates.dismiss;
    if (state.gates.readyDismiss === null && dismiss.length && state.gates.skip !== null) {
        for (let i = 0; i < dismiss.length; i++) {
            if (dismiss[i] > state.gates.skip) {
                state.gates.readyDismiss = dismiss[i];
                break;
            }
        }
    }
}

function stampGateEvents() {
    const g = state.gates;
    if (g.skip !== null && g.skip >= 0 && g.skip < state.frames.length) {
        state.frames[g.skip][4] = (state.frames[g.skip][4] || 0) | EVENT_SKIP_INTRO;
    }
    const marks = (g.dismiss || []).slice();
    if (g.readyDismiss !== null) marks.push(g.readyDismiss);
    marks.forEach(function (i) {
        if (i >= 0 && i < state.frames.length) {
            state.frames[i][4] = (state.frames[i][4] || 0) | EVENT_DISMISS;
        }
    });
}

function noteGate(index, events) {
    if ((events & EVENT_SKIP_INTRO) !== 0) {
        state.gates.skip = index;
        if (state.introSkipBaseline === null) state.introSkipBaseline = index;
    }
    if ((events & EVENT_DISMISS) !== 0) {
        if (state.gates.dismiss.indexOf(index) < 0) state.gates.dismiss.push(index);
        if (state.gates.readyDismiss === null
            && state.gates.skip !== null && index > state.gates.skip) {
            state.gates.readyDismiss = index;
        }
    }
}

// Rewind shortens the take. Keep Get Ready dismiss sticky so re-recording
// through that frame restores the tap even when the live message is already gone.
function trimGates(rec) {
    const n = Math.max(0, rec | 0);
    if (state.gates.skip !== null && state.gates.skip >= n) state.gates.skip = null;
    state.gates.dismiss = (state.gates.dismiss || []).filter(i => i < n);
    // readyDismiss stays even when n is before it - noteSampledFrame re-stamps.
}

function syncPreviousFlags() {
    previous.intro = level.introPlaying();
    previous.message = level.messageUp();
    previous.ready = level.readyPrompt();
    previous.complete = level.complete();
}

function armPlaybackGates() {
    stampGateEvents();
    rebuildGatesFromFrames();
    stampGateEvents();
    state.skipAt = state.gates.skip !== null ? state.gates.skip : firstEventFrame(EVENT_SKIP_INTRO);
    state.dismissAt = state.gates.readyDismiss !== null
        ? state.gates.readyDismiss
        : firstEventFrame(EVENT_DISMISS);
}

function rowEvents(offset) {
    const i = state.cursor + (offset || 0);
    if (i < 0 || i >= state.frames.length) return 0;
    return state.frames[i][4] || 0;
}

// RECORD samples skip/dismiss after the frame. Fire those taps before
// processGameFrame so intro/platforms do not run one extra tick.
function replayGates(view) {
    const ev = rowEvents(0);
    if ((ev & EVENT_SKIP_INTRO) !== 0 ||
        (level.introPlaying() && (rowEvents(-1) & EVENT_SKIP_INTRO) !== 0)) {
        if (level.skipIntro(true)) log.info(`PLAY skip intro @${state.cursor}f`, 'macro');
    }
    if ((ev & EVENT_DISMISS) !== 0 ||
        (level.messageUp() && (rowEvents(-1) & EVENT_DISMISS) !== 0)) {
        if (level.dismissMessage(view || frame.state.view)) {
            log.info(`PLAY dismiss @${state.cursor}f`, 'macro');
        }
    }
}

function tailLimit() {
    if (state.resumeAtEnd || state.seekTo !== null) return state.frames.length;
    return state.frames.length + FINISH_PAD;
}

function playRow() {
    if (state.cursor < 0) return null;
    if (state.cursor < state.frames.length) return state.frames[state.cursor];
    if (state.cursor < tailLimit() && state.frames.length > 0) {
        const last = state.frames[state.frames.length - 1];
        return [0, 0, 0, last[3], 0];
    }
    return null;
}

function applyBeforeFrame() {
    if (state.mode !== 'playing') return;
    if (!state.resumeAtEnd && state.seekTo === null && level.complete()) {
        endPlayback();
        return;
    }

    const row = playRow();
    if (row === null) {
        if (state.seekTo === null) endPlayback();
        return;
    }

    if (state.cursor < state.frames.length) replayGates(frame.state.view);

    input.setOverride(row[0], row[1]);
    input.setButton('a', (row[2] & BUTTON_A) !== 0);
    input.setButton('b', (row[2] & BUTTON_B) !== 0);
    // Start the tick on the yaw RECORD's tick started on. Column 5 has it
    // (tapes from now on). Older tapes only have the post-tick yaw, which is
    // the same thing whenever tilt steer is 0 (pan happens between ticks);
    // the previous row would miss the pan, which is what broke L26 before.
    const startYaw = row.length > 5 && isFinite(row[5]) ? row[5] : row[3];
    if (state.pinYaw && isFinite(startYaw) && !level.introPlaying() && !level.complete()) {
        mem.global('cameraYaw').writeFloat(startYaw);
    }
}

function applyAfterFrame(view) {
    if (state.mode !== 'playing') return;
    if (!state.resumeAtEnd && state.seekTo === null && level.complete()) {
        endPlayback();
        return;
    }
    const row = playRow();
    if (row === null) return;

    const introNow = level.introPlaying();
    if (playIntroWas && !introNow && state.skipAt > state.cursor) {
        log.warn(`intro ended on its own at ${state.cursor}f, before the recorded skip`
            + ` at ${state.skipAt}f - the start is shifted too far forward`
            + ` (about ${state.skipAt - state.cursor}f too late)`, 'macro');
    }
    playIntroWas = introNow;

    if (state.cursor < state.frames.length) {
        tracePlay(state.cursor);
        let live = null;
        let yaw = NaN;
        try {
            live = {
                steer: mem.global('tiltSteer').readFloat(),
                thrust: mem.global('tiltThrust').readFloat(),
            };
            yaw = mem.global('cameraYaw').readFloat();
        } catch (err) { /* */ }
        tapePlay(state.cursor, row, live, yaw);
        physCheckpoint(state.cursor);
    }

    if (state.pinYaw && isFinite(row[3]) && !level.introPlaying() && !level.complete()) {
        mem.global('cameraYaw').writeFloat(row[3]);
    }

    state.cursor += 1;
    if (frame.nativePlaying()) frame.setNativeCursor(state.cursor);

    if (playRow() === null && state.seekTo === null) {
        endPlayback();
        return;
    }

    if (state.seekTo !== null && state.cursor >= state.seekTo) {
        const n = state.seekTo;
        const rec = state.seekRecord;
        state.seekTo = null;
        state.seekRecord = false;
        input.setOverride(null);
        input.setButton('a', false);
        input.setButton('b', false);
        if (n < state.frames.length) {
            state.frames.length = n;
            state.complete = false;
        }
        frame.setPaused(true);
        if (rec) {
            state.mode = 'recording';
            previous.intro = level.introPlaying();
            previous.message = level.messageUp();
            previous.ready = level.readyPrompt();
            previous.complete = level.complete();
            try { require('./rewind').capture(); } catch (err) { /* */ }
            persist('seek', false);
            log.info(`seek landed at ${n}f, recording (undo from here)`, 'macro');
        } else {
            state.mode = 'idle';
            log.info(`seek landed at ${n}f`, 'macro');
        }
        if (state.shiftResync) endShiftResync(true);
    }
}

// While arming, wait for the restart to land before counting frames.
function checkArmed() {
    if (state.mode !== 'arming') return;
    if (level.restartPending() || !level.inLevel()) return;
    if (level.settling()) return;

    previous.intro = level.introPlaying();
    previous.message = level.messageUp();
    previous.ready = level.readyPrompt();
    previous.complete = level.complete();

    const armMode = state.pendingMode;
    state.pendingMode = null;
    try { frame.resetClock(); } catch (err) { /* */ }
    if (armMode === 'recording') {
        state.complete = false;
        state.mode = 'recording';
        state.awayFrames = 0;
        state.armedAt = frame.state.frame;
        try { log.beginTape(`BEGIN REC level ${levelNumber()}`); } catch (err) { /* */ }
        armPhysics();
        log.info('recording armed', 'macro');
        try { require('./rewind').capture(); } catch (err) { /* */ }
    } else {
        state.cursor = 0;
        state.mode = 'playing';
        state.armedAt = frame.state.frame;
        resetStartYaw();
        armPlaybackGates();
        beginTrace();
        playIntroWas = level.introPlaying();
        try {
            log.beginTape(`BEGIN ${state.resumeAtEnd ? 'CONTINUE' : 'PLAY'} ${state.frames.length}f`
                + ` level ${levelNumber()}`);
        } catch (err) { /* */ }
        armPhysics();
        log.info(`playback armed ${state.frames.length}f`
            + (state.seekTo !== null ? ` seek=${state.seekTo}` : '')
            + (state.skipAt >= 0 ? ` skip@${state.skipAt}` : ' skip=wait')
            + (state.dismissAt >= 0 ? ` ready@${state.dismissAt}` : ' ready=wait'), 'macro');
        try { frame.stopNativePlay(); } catch (err) { /* */ }
        try { frame.syncHot(); } catch (err) { /* */ }
    }
}

function turboSteps() {
    return 0;
}

function endPlayback() {
    if (state.mode !== 'playing') return;
    traceSummary();
    try { log.flushTape(); } catch (err) { /* */ }
    try { frame.stopNativePlay(); } catch (err) { /* */ }
    input.setOverride(null);
    input.setButton('a', false);
    input.setButton('b', false);
    resetVisualCam();
    const n = state.frames.length;
    if (state.resumeAtEnd && state.refreshing) {
        landRefresh(n);
        return;
    }
    if (state.resumeAtEnd) {
        state.resumeAtEnd = false;
        state.resumeState = snapshot();
        state.mode = 'recording';
        state.awayFrames = 0;
        state.armedAt = frame.state.frame;
        previous.intro = level.introPlaying();
        previous.message = level.messageUp();
        previous.ready = level.readyPrompt();
        previous.complete = level.complete();
        persist('continue', false);
        // Undo = the snapshots this replay captured (fresh physics). The
        // RECORD ones stashed before it are the old physics; drop them.
        try { require('./rewind').dropStash(); } catch (err) { /* */ }
        try { require('./rewind').capture(); } catch (err) { /* */ }
        let undo = 0;
        try { undo = require('./rewind').depth(); } catch (err) { /* */ }
        if (state.continuePauses) {
            silencingPause = true;
            try { frame.setPaused(true); } catch (err) { /* */ }
            silencingPause = false;
            log.info(`CONTINUE landed at ${n}f, paused - RESUME to keep recording  ${fmtBall()}`
                + `  undo ${undo}f`, 'macro');
        } else {
            log.info(`CONTINUE landed at ${n}f - keep recording  ${fmtBall()}`
                + `  undo ${undo}f`, 'macro');
        }
        return;
    }
    state.resumeAtEnd = false;
    // The last recorded frame is the void/flash tick. levelComplete is set
    // on a later processGameFrame (death warp). Pause here and the victory
    // screen never draws until someone hits RESUME.
    state.mode = 'lingering';
    state.lingerUntil = 1;
    state.lingerWait = 0;
    state.lingerHold = level.complete() ? 1 : 0;
    state.lingerAway = 0;
    silencingPause = true;
    frame.setPaused(false);
    silencingPause = false;
    log.info(`PLAY ${n}f done - letting the finish play out`, 'macro');
}

function beforeRender() {
    restoreVisualCam();
    applyVisualCam();
}

function afterRender() {
    restoreVisualCam();
}

function afterFrame() {
    watchNativePause();
    tickLinger();
}

function beforeFrame() {
    checkArmed();
    if (frame.nativePlaying()) state.cursor = frame.nativeCursor();
    recordingAtPre = state.mode === 'recording';
    if (recordingAtPre) {
        try { preTickYaw = mem.global('cameraYaw').readFloat(); } catch (err) { preTickYaw = NaN; }
    }
    applyBeforeFrame();
}

function install() {
    beforeFrame._tasName = 'macro.before';
    applyAfterFrame._tasName = 'macro.after';
    sampleAfterFrame._tasName = 'macro.sample';
    beforeRender._tasName = 'macro.predraw';
    afterRender._tasName = 'macro.render';
    afterFrame._tasName = 'macro.linger';
    frame.onBeforeFrame(beforeFrame, 'level');
    frame.onAfterFrame(applyAfterFrame, 'level');
    frame.onAfterFrame(sampleAfterFrame, 'level');
    frame.onAfterFrame(afterFrame, 'level');
    frame.onBeforeRender(beforeRender, 'level');
    frame.onAfterRender(afterRender, 'level');
    frame.onPauseChange(onTasPause);
    frame.setExtraSim(turboSteps);
}

// -------------------------------------------------------------- control

// Recording always restarts the level so frame 0 is a known state.
function record(options) {
    const opts = options || {};
    if (state.mode === 'recording' || state.mode === 'playing') {
        log.info('RECORD: stopping current take first', 'macro');
        stop();
    }
    if (busy()) {
        state.lastError = 'still restarting - wait';
        log.warn(state.lastError, 'macro');
        return false;
    }

    stop();

    if (!opts.keep) {
        state.frames = [];
        state.complete = false;
        state.resumeState = null;
        resetGates(true);
        resetTrace();
        state.cutPending = false;
    }
    state.cursor = 0;
    forgetBackups();
    // A fresh take on another level must not autosave under the name of the
    // macro loaded from a different level (that is how runs got swapped).
    const here = levelNumber();
    const foreign = typeof state.fileLevel === 'number' && state.fileLevel !== here;
    if (foreign && !opts.keep) {
        if (opts.name && opts.name === state.loaded) {
            log.warn(`RECORD: "${opts.name}" belongs to level ${state.fileLevel};`
                + ' this take is unnamed - SAVE it with a new name', 'macro');
            opts.name = null;
        }
        state.loaded = null;
        state.autoSaveName = null;
    }
    state.loaded = opts.name || state.loaded;
    state.autoSaveName = opts.name || state.autoSaveName;
    state.pendingMode = 'recording';
    state.resumeAtEnd = false;
    state.lingerUntil = 0;
    state.seekTo = null;
    state.seekRecord = false;

    if (opts.restart === false) {
        previous.intro = level.introPlaying();
        previous.message = level.messageUp();
        previous.ready = level.readyPrompt();
        previous.complete = level.complete();
        if (typeof state.fileLevel !== 'number' || state.frames.length === 0) {
            state.fileLevel = levelNumber();
        }
        state.mode = 'recording';
        log.info(`recording from live state ${state.frames.length}f`, 'macro');
        try { frame.syncHot(); } catch (err) { /* */ }
        return true;
    }

    if (!level.inLevel()) {
        state.lastError = 'open a level first';
        return false;
    }

    frame.setStepHz(60);
    frame.setFixedStep(true);
    frame.setPaused(false);
    level.dismissPauseMenu();
    state.fileLevel = levelNumber();
    state.mode = 'arming';
    log.info('RECORD: restart then capture', 'macro');
    level.restart(null, state.fileLevel);
    return true;
}

function play(options) {
    const opts = options || {};
    if (busy()) {
        state.lastError = 'still restarting - wait';
        log.warn(state.lastError, 'macro');
        return false;
    }
    if (state.frames.length === 0) {
        state.lastError = 'nothing recorded';
        return false;
    }
    if (!level.inLevel()) {
        state.lastError = 'open a level first';
        return false;
    }

    state.pinYaw = opts.pinYaw !== false;
    // resume() passes continue:true and sets resumeAtEnd first — keep it.
    if (!opts.continue) state.resumeAtEnd = false;
    state.lingerUntil = 0;
    state.lingerWait = 0;
    state.lingerHold = 0;
    state.lingerAway = 0;
    state.playFromStart = opts.seekTo === undefined || opts.seekTo === null;
    state.playClean = !!opts.clean;
    state.playSmoothCam = !!state.smoothCam;
    state.pendingMode = 'playing';
    if (opts.seekTo === undefined) {
        state.seekTo = null;
        state.seekRecord = false;
    }
    resetStartYaw();
    try {
        const rw = require('./rewind');
        if (opts.continue) rw.stashForContinue(state.frames.length);
        else rw.dropStash();
    } catch (err) { /* */ }

    persist(opts.continue ? 'before-continue' : 'before-play', false);
    frame.setStepHz(60);
    frame.setFixedStep(true);
    frame.setPaused(false);
    level.dismissPauseMenu();
    state.mode = 'arming';
    const playLevel = (typeof state.fileLevel === 'number') ? state.fileLevel : levelNumber();
    log.info(`${state.resumeAtEnd ? 'CONTINUE' : 'PLAY'} ${state.frames.length}f`
        + ` level ${playLevel}`
        + (state.seekTo !== null ? ` to ${state.seekTo}` : ''), 'macro');
    level.restart(null, playLevel);
    return true;
}

// REFRESH PHYSICS. Rewind puts the ball back but not Bullet's contact cache,
// pair list, tree or world order, so frames recorded after many -N can play
// back differently from a clean start. This is CONTINUE at up to 8x that lands
// paused in RECORD, with the undo buffer rebuilt from the fresh replay and
// the fresh ball path kept as the new PLAY reference. The first frame that
// came out different is logged; nothing is cut.
function refresh() {
    if (state.mode === 'playing' && state.refreshing) {
        state.lastError = 'already refreshing - wait';
        return false;
    }
    if (state.complete) {
        state.lastError = 'this take already finishes - PLAY checks it';
        return false;
    }
    const n = state.frames.length;
    state.refreshing = true;
    state.refreshSpeed = frame.state.speed;
    trace.fresh = [];
    trace.freshDig = [];
    state.refreshStarted = Date.now();
    fastReplay(true);
    if (!resume()) {
        endRefresh();
        return false;
    }
    log.info(`REFRESH PHYSICS: replaying ${n}f at ${REFRESH_SPEED}x`, 'macro');
    return true;
}

function refreshing() { return state.refreshing; }

// CONTINUE / REFRESH replays feed the undo buffer, so after it lands (or
// you pause it) -N walks back through what you just watched.
function continueCapturing() {
    return state.mode === 'playing' && state.resumeAtEnd;
}

// PAUSE or -N during CONTINUE: leave off at the frame on screen and record
// from there. Frames after it are dropped from memory only; the file keeps
// the full take until something new is recorded.
function landContinue(why) {
    if (!(state.mode === 'playing' && state.resumeAtEnd)) return false;
    const n = Math.max(0, Math.min(state.cursor | 0, state.frames.length));
    const total = state.frames.length;
    if (n < total) {
        state.frames.length = n;
        state.complete = false;
        try { trimGates(n); } catch (err) { /* */ }
        state.cutPending = true;
        log.info(`CONTINUE stopped at ${n}f of ${total}f (${why}) - recording from here.`
            + ` The file still has all ${total}f until you record a new frame;`
            + ` LOAD it to get the rest back.`, 'macro');
    }
    silencingPause = true;
    try { endPlayback(); } finally { silencingPause = false; }
    silencingPause = true;
    try { frame.setPaused(true); } finally { silencingPause = false; }
    return true;
}

function endRefresh() {
    if (!state.refreshing) return;
    state.refreshing = false;
    trace.fresh = null;
    trace.freshDig = null;
    fastReplay(false, state.refreshSpeed);
}

function fastReplay(on, restore) {
    try {
        if (on) {
            frame.setFastCap(REFRESH_SPEED);
            frame.setSpeed(REFRESH_SPEED);
        } else {
            frame.setFastCap(0);
            frame.setSpeed(restore || 1);
        }
    } catch (err) { /* */ }
}

function landRefresh(n) {
    const secs = (Date.now() - (state.refreshStarted || Date.now())) / 1000;
    if (secs > 0) {
        log.info(`REFRESH took ${secs.toFixed(1)}s (${(n / 60 / secs).toFixed(1)}x real time)`, 'macro');
    }
    const drift = trace.first;
    const max = trace.max;
    const maxAt = trace.maxAt;
    const compared = trace.src !== null && trace.n > 0;
    if (trace.fresh !== null && trace.fresh.length > 0) {
        trace.pts = trace.fresh;
        trace.dig = trace.freshDig || [];
        trace.src = 'rec';
    }
    endRefresh();
    state.resumeAtEnd = false;
    state.resumeState = snapshot();
    state.mode = 'recording';
    state.awayFrames = 0;
    state.armedAt = frame.state.frame;
    previous.intro = level.introPlaying();
    previous.message = level.messageUp();
    previous.ready = level.readyPrompt();
    previous.complete = level.complete();
    persist('refresh', false);
    const rw = require('./rewind');
    // The stashed RECORD snapshots are the old physics; the ones taken during
    // this replay are the new. Keep only the new.
    try { rw.dropStash(); } catch (err) { /* */ }
    try { rw.capture(); } catch (err) { /* */ }
    let undo = 0;
    try { undo = rw.depth(); } catch (err) { /* */ }
    silencingPause = true;
    try { frame.setPaused(true); } catch (err) { /* */ }
    silencingPause = false;
    if (!compared) {
        log.info(`REFRESH landed at ${n}f, paused (no earlier path to compare)  undo ${undo}f`, 'macro');
    } else if (drift < 0) {
        log.info(`REFRESH landed at ${n}f, paused - matched the recording all the way`
            + `  undo ${undo}f`, 'macro');
    } else {
        log.info(`REFRESH landed at ${n}f, paused - DRIFTED from ${drift}f`
            + ` (max ${max.toFixed(3)}u @${maxAt}f). Frames kept; PLAY now matches this`
            + ` replay. Not happy with it? Rewind to before ${drift}f, re-record, REFRESH again.`
            + `  undo ${undo}f`, 'macro');
    }
}

function seek(frameIndex, thenRecord) {
    if (state.frames.length === 0) {
        state.lastError = 'nothing recorded';
        return false;
    }
    if (busy()) {
        state.lastError = 'still restarting - wait';
        return false;
    }
    const n = Math.max(0, Math.min(frameIndex | 0, state.frames.length));
    state.seekTo = n;
    state.seekRecord = !!thenRecord;
    state.resumeAtEnd = false;
    log.info(`seek replay to ${n}f then ${thenRecord ? 'record' : 'pause'}`, 'macro');
    return play({ seekTo: n });
}

function resume() {
    if (busy()) {
        state.lastError = 'still restarting - wait';
        return false;
    }
    if (state.mode === 'playing' && state.resumeAtEnd) {
        state.lastError = 'still continuing - wait';
        return false;
    }
    if (state.frames.length === 0) {
        state.lastError = 'nothing to continue';
        return false;
    }
    if (state.complete) {
        state.lastError = 'this macro already finishes the level';
        return false;
    }
    state.resumeAtEnd = true;
    if (!play({ continue: true })) {
        state.resumeAtEnd = false;
        return false;
    }
    return true;
}

function stop() {
    if (state.mode === 'lingering') endLinger();
    try { frame.stopNativePlay(); } catch (err) { /* */ }
    const wasRec = state.mode === 'recording';
    const n = state.frames.length;
    resetVisualCam();
    if (state.mode === 'playing') {
        input.setOverride(null);
        input.setButton('a', false);
        input.setButton('b', false);

        if (!(state.resumeAtEnd && state.cursor >= state.frames.length)) {
            traceSummary();
            try { log.flushTape(); } catch (err) { /* */ }
        }
        if (state.resumeAtEnd && state.cursor >= state.frames.length) {
            endPlayback();
            return;
        }
        state.resumeAtEnd = false;
    }
    if (wasRec && !state.complete) {
        state.resumeState = snapshot();
        if (n > 0 && state.autoSaveName !== null) {
            persist('stop', true);
            log.info(`STOP saving ${state.autoSaveName} ${n}f`, 'macro');
        } else if (n > 0) {
            log.info(`STOP ${n}f unsaved - name it and SAVE`, 'macro');
        }
    }
    state.mode = 'idle';
    state.seekTo = null;
    state.seekRecord = false;
    endRefresh();
    if (state.shiftResync) endShiftResync(false);
    try { frame.syncHot(); } catch (err) { /* */ }
}

function clear() {
    stop();
    state.frames = [];
    state.cursor = 0;
    state.loaded = null;
    state.complete = false;
    state.resumeState = null;
    state.cutPending = false;
    resetGates(true);
    resetTrace();
}

function resetGates(full) {
    state.gates = { skip: null, readyDismiss: null, dismiss: [] };
    state.skipAt = -1;
    state.dismissAt = -1;
    state.shift = null;
    if (full) {
        state.introSkipBaseline = null;
        state.framesBaseline = null;
        state.gatesBaseline = null;
    }
}

function shifting() {
    return state.shift !== null || !!state.shiftResync;
}

function shiftDelta() {
    const sh = state.shift || state.shiftResync;
    return sh ? (sh.delta | 0) : 0;
}

function pinShiftBall() {
    const s = state.shift;
    if (!s || !s.origin) return;
    try {
        ball.teleport(s.origin.x, s.origin.y, s.origin.z, { keepVelocity: false });
        ball.stop();
    } catch (err) { /* */ }
    try {
        mem.global('cameraYaw').writeFloat(s.yaw);
    } catch (err) { /* */ }
}

function beginShift() {
    if (state.shift) {
        state.lastError = 'already shifting platforms';
        return false;
    }
    if (state.mode === 'playing' || state.mode === 'arming') {
        state.lastError = 'stop PLAY first';
        return false;
    }
    if (state.frames.length === 0) {
        state.lastError = 'no macro loaded';
        return false;
    }
    if (!level.inLevel() || level.inMainMenu()) {
        state.lastError = 'enter the level first (CONTINUE or RECORD)';
        return false;
    }
    rebuildGatesFromFrames();
    if (state.gates.skip === null) {
        state.lastError = 'macro has no intro-skip tap - record one first';
        return false;
    }
    const pos = ball.physicsPosition();
    if (!pos || !isFinite(pos.x)) {
        state.lastError = 'ball not ready';
        return false;
    }
    if (state.framesBaseline === null) {
        state.framesBaseline = state.frames.map(r => r.slice());
        state.gatesBaseline = cloneGates(state.gates);
        if (state.introSkipBaseline === null) {
            state.introSkipBaseline = state.gates.skip;
        }
    }
    let yaw = 0;
    try { yaw = mem.global('cameraYaw').readFloat(); } catch (err) { /* */ }
    state.shift = {
        origin: { x: pos.x, y: pos.y, z: pos.z },
        yaw,
        delta: 0,
        applied: 0,   // part of delta already written into state.frames
        base: state.frames.map(r => r.slice()),
        baseGates: cloneGates(state.gates),
        speed: 1,
    };
    try { ball.stop(); } catch (err) { /* */ }
    frame.setPaused(true);
    log.info(`SHIFT INTRO begin - ball frozen, +N / -N moves the platform cycle`
        + ` (skip@${state.gates.skip})`, 'macro');
    return true;
}

// Platforms only simulate forward, so +N advances them live. Going back is
// a replay: the take is rebuilt with the skip tap earlier and replayed at up to 8x
// to the same point of the run, then shifting resumes from there. -N taps
// within RESYNC_MS are batched into one replay.
const SHIFT_FWD_MAX = 3600;
const RESYNC_MS = 700;
let resyncTimer = null;

function shiftSkipBase() {
    const g = state.shift ? state.shift.baseGates : null;
    return g && g.skip !== null ? g.skip : null;
}

// state.frames / gates = the take as it was when SHIFT began, with the intro
// skip moved by d (d > 0 inserts idle intro frames, d < 0 removes them).
function buildShifted(d) {
    const sh = state.shift || state.shiftResync;
    state.frames = sh.base.map(r => r.slice());
    state.gates = cloneGates(sh.baseGates);
    if (d === 0) {
        stampGateEvents();
        return true;
    }
    const S = state.gates.skip;
    if (S === null || S < 0 || S >= state.frames.length) return false;
    const row = state.frames[S];
    if (d > 0) {
        const idle = [];
        for (let i = 0; i < d; i++) idle.push([0, 0, 0, row[3], 0]);
        Array.prototype.splice.apply(state.frames, [S, 0].concat(idle));
    } else {
        state.frames.splice(S + d, -d);
    }
    state.gates.skip = S + d;
    state.frames[S + d][4] = (state.frames[S + d][4] || 0) | EVENT_SKIP_INTRO;
    state.gates.dismiss = (state.gates.dismiss || []).map(i => (i >= S ? i + d : i));
    if (state.gates.readyDismiss !== null && state.gates.readyDismiss >= S) {
        state.gates.readyDismiss += d;
    }
    stampGateEvents();
    return true;
}

function shiftStep(n) {
    if (state.shiftResync) {
        state.lastError = 'replaying the shift - wait';
        return false;
    }
    if (!state.shift) {
        state.lastError = 'not shifting';
        return false;
    }
    const steps = n | 0;
    if (steps === 0) return true;
    const sh = state.shift;
    if (steps > 0) {
        const room = SHIFT_FWD_MAX - sh.delta;
        const k = Math.min(steps, room);
        if (k <= 0) {
            state.lastError = `shift capped at +${SHIFT_FWD_MAX}f`;
            return false;
        }
        frame.setPaused(true);
        for (let i = 0; i < k; i++) {
            frame.advance(1);
            pinShiftBall();
            sh.delta += 1;
        }
        log.info(`SHIFT INTRO +${k}  pending ${fmtShift(sh.delta)}f`, 'macro');
        return true;
    }
    const S = shiftSkipBase();
    const min = S === null ? 0 : 1 - S; // skip no earlier than intro frame 1
    const next = Math.max(sh.delta + steps, min);
    if (next === sh.delta) {
        state.lastError = `already at intro frame 1 (${fmtShift(sh.delta)}f)`;
        return false;
    }
    sh.delta = next;
    log.info(`SHIFT INTRO ${steps}  pending ${fmtShift(sh.delta)}f`
        + (next === min && sh.delta + steps < min ? ' (stopped at intro frame 1)' : '')
        + ' - replaying to preview', 'macro');
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(function () {
        resyncTimer = null;
        try {
            ObjC.schedule(ObjC.mainQueue, function () {
                try { shiftResync(); } catch (err) { log.warn(`shift replay: ${err.message}`, 'macro'); }
            });
        } catch (err) { /* */ }
    }, RESYNC_MS);
    return true;
}

function fmtShift(d) { return d > 0 ? `+${d}` : `${d}`; }

function shiftResync() {
    const sh = state.shift;
    if (!sh || state.shiftResync) return false;
    if (!buildShifted(sh.delta)) {
        state.lastError = 'intro skip missing - cannot shift';
        return false;
    }
    sh.applied = sh.delta;
    state.shiftResync = sh;
    state.shift = null;
    state.complete = false;
    sh.speed = frame.state.speed;
    fastReplay(true);
    const target = state.frames.length;
    log.info(`SHIFT INTRO preview: replaying ${target}f at ${REFRESH_SPEED}x`
        + ` with the skip at ${state.gates.skip}f`, 'macro');
    if (!seek(target, true)) {
        endShiftResync(false);
        return false;
    }
    return true;
}

// seek landed (or failed): back to shifting on the replayed world.
function endShiftResync(landed) {
    const sh = state.shiftResync;
    if (!sh) return;
    state.shiftResync = null;
    fastReplay(false, sh.speed);
    const pos = ball.physicsPosition();
    if (landed && pos && isFinite(pos.x)) sh.origin = { x: pos.x, y: pos.y, z: pos.z };
    try { sh.yaw = mem.global('cameraYaw').readFloat(); } catch (err) { /* */ }
    state.shift = sh;
    try { ball.stop(); } catch (err) { /* */ }
    frame.setPaused(true);
    log.info(landed
        ? `SHIFT INTRO preview ready at ${fmtShift(sh.delta)}f - keep shifting or STOP SHIFT`
        : 'SHIFT INTRO preview failed - still shifting', 'macro');
}

function cancelShift() {
    if (resyncTimer !== null) { clearTimeout(resyncTimer); resyncTimer = null; }
    const sh = state.shift;
    if (!sh) return false;
    const d = sh.delta | 0;
    state.shift = null;
    if (sh.applied) {
        state.frames = sh.base.map(r => r.slice());
        state.gates = cloneGates(sh.baseGates);
        stampGateEvents();
    }
    log.info(`SHIFT INTRO cancelled (abandoned ${fmtShift(d)}f)`
        + ' - PLAY to resync the world', 'macro');
    return true;
}

function applyShift() {
    if (!state.shift) {
        state.lastError = 'not shifting';
        return false;
    }
    if (resyncTimer !== null) { clearTimeout(resyncTimer); resyncTimer = null; }
    const sh = state.shift;
    const d = sh.delta | 0;
    if (!buildShifted(d)) {
        state.lastError = 'intro skip missing - cannot apply';
        return false;
    }
    state.shift = null;
    if (d === 0) {
        log.info('SHIFT INTRO apply 0f - nothing changed', 'macro');
        return true;
    }
    state.complete = false;
    persist('intro-shift', true);
    log.info(`SHIFT INTRO applied ${fmtShift(d)}f - skip ${sh.baseGates.skip} -> ${state.gates.skip},`
        + ` take now ${state.frames.length}f`, 'macro');
    return true;
}

function canRevertIntro() {
    return state.framesBaseline !== null && state.gatesBaseline !== null;
}

function revertIntroShift() {
    if (!canRevertIntro()) {
        state.lastError = 'no original intro timing saved';
        return false;
    }
    if (state.shift) state.shift = null;
    state.frames = state.framesBaseline.map(r => r.slice());
    state.gates = cloneGates(state.gatesBaseline);
    stampGateEvents();
    state.complete = false;
    persist('intro-revert', true);
    log.info(`SHIFT INTRO reverted to original skip@${state.gates.skip}`
        + ` (${state.frames.length}f)`, 'macro');
    return true;
}

function length() { return state.frames.length; }

function progress() {
    if (state.frames.length === 0) return 0;
    return Math.min(1, state.cursor / state.frames.length);
}

function describe() {
    const n = state.frames.length;
    const seconds = (n / 60).toFixed(2);
    if (state.shift) {
        return `SHIFT INTRO  +${state.shift.delta}f pending`
            + `  skip@${state.gates.skip}`
            + `  (ball frozen, platforms move with +N)`;
    }
    if (state.mode === 'arming') return 'restarting level...';
    if (state.mode === 'recording') {
        let undo = 0;
        try { undo = require('./rewind').depth(); } catch (err) { undo = 0; }
        return `REC  ${n}f  ${seconds}s`
            + (frame.state.paused ? '  PAUSED' : '')
            + `  undo ${undo}f`
            + `  ${state.autoSaveName || state.loaded || 'unsaved'}`
            + `  [${level.phase()}]`;
    }
    if (state.mode === 'playing') {
        const tail = state.cursor > n ? ` +${state.cursor - n} hold` : '';
        return `PLAY ${Math.min(state.cursor, n)}/${n}f${tail}  [${level.phase()}]`
            + (state.smoothCam ? '  smooth cam' : '');
    }
    if (state.mode === 'lingering') {
        return state.lingerHold > 0
            ? `FINISH ${n}f - holding timer ${state.lingerHold}/75`
            : `FINISH ${n}f - waiting for victory ${state.lingerWait}/180`;
    }
    if (n === 0) return 'no macro';
    return `${state.loaded || 'unsaved'}  ${n}f  ${seconds}s  `
        + (state.complete ? 'FINISHED' : 'partial');
}

// ---------------------------------------------------------- persistence

function documentsPath() {
    const urls = ObjC.classes.NSFileManager.defaultManager()
        .URLsForDirectory_inDomains_(9 /* NSDocumentDirectory */, 1 /* NSUserDomainMask */);
    if (urls === null || urls.count() === 0) return null;
    return urls.objectAtIndex_(0).path().toString();
}

function macroDirectory() {
    const docs = documentsPath();
    if (docs === null) return null;
    const dir = `${docs}/aerox-tas`;
    ObjC.classes.NSFileManager.defaultManager()
        .createDirectoryAtPath_withIntermediateDirectories_attributes_error_(
            dir, true, NULL, NULL);
    return dir;
}

// Macros are keyed by level so the panel can offer only the relevant ones.
function fileName(name, levelIndex) {
    const n = levelIndex === undefined ? levelNumber() : levelIndex;
    return `level${String(n).padStart(3, '0')}__${name}.json`;
}

function persist(reason, force) {
    const name = state.autoSaveName || state.loaded;
    if (!name || state.frames.length === 0) return false;
    if (state.cutPending) {
        persistDirty = true;
        return false;
    }
    // -N / seek / PLAY setup must not rewrite the file. Each rewind after
    // CONTINUE used to save a shorter Hi, which is how the second half vanished.
    if (reason === 'rewind' || reason === 'seek' || reason === 'before-play'
        || reason === 'before-continue' || reason === 'continue') {
        persistDirty = true;
        return false;
    }
    const urgent = force && (reason === 'crash' || reason === 'pause'
        || reason === 'stop' || reason === 'intro-shift' || reason === 'intro-revert');
    if (!urgent && state.frames.length === persistLen && !persistDirty) return false;
    const now = Date.now();
    if (!urgent && now < persistAt) {
        persistDirty = true;
        return false;
    }
    persistWant = { name, reason, urgent };
    persistDirty = true;
    if (reason === 'crash') return flushPersist();
    if (persistTimer !== null) return false;
    persistTimer = setTimeout(function () {
        persistTimer = null;
        try {
            ObjC.schedule(ObjC.mainQueue, function () {
                try { flushPersist(); } catch (err) { /* */ }
            });
        } catch (err) {
            try { flushPersist(); } catch (err2) { /* */ }
        }
    }, urgent ? 0 : (reason === 'continue' ? 1200 : 500));
    return false;
}

function flushPersist() {
    const want = persistWant;
    persistWant = null;
    if (want === null) return false;
    const ok = save(want.name);
    if (ok) {
        persistAt = Date.now() + 2500;
        persistLen = state.frames.length;
        persistDirty = false;
        if (want.reason && want.reason !== 'checkpoint' && want.reason !== 'rewind') {
            log.info(`auto-saved ${want.name} ${state.frames.length}f (${want.reason})`, 'macro');
        }
    }
    return !!ok;
}

function f32bits(n) {
    const a = new Float32Array(1);
    a[0] = +n;
    return new Uint32Array(a.buffer)[0] >>> 0;
}

function bitsf32(u) {
    const a = new Uint32Array(1);
    a[0] = u >>> 0;
    return new Float32Array(a.buffer)[0];
}

function packFrames(frames) {
    const out = [];
    for (let i = 0; i < frames.length; i++) {
        const r = frames[i];
        const row = [f32bits(r[0]), f32bits(r[1]), r[2] | 0, f32bits(r[3]), r[4] | 0];
        if (r.length > 5 && isFinite(r[5])) row.push(f32bits(r[5]));
        out.push(row);
    }
    return out;
}

function unpackFrames(frames, version) {
    if (version < 3) return frames;
    const out = [];
    for (let i = 0; i < frames.length; i++) {
        const r = frames[i];
        const row = [bitsf32(r[0]), bitsf32(r[1]), r[2] | 0, bitsf32(r[3]), r[4] | 0];
        if (r.length > 5) row.push(bitsf32(r[5]));
        out.push(row);
    }
    return out;
}

function save(name) {
    const dir = macroDirectory();
    if (dir === null || state.frames.length === 0) return false;

    stampGateEvents();
    // The take's own level, not the one on screen. The PAUSE button autosaves
    // the loaded take; on another level that wrote a copy into its list.
    const lv = takeLevel();
    const payload = JSON.stringify({
        version: FILE_VERSION,
        level: lv,
        controls: input.activeMode(),
        stepSeconds: frame.state.stepSeconds,
        complete: state.complete,
        resumeState: state.resumeState,
        gates: cloneGates(state.gates),
        introSkipBaseline: state.introSkipBaseline,
        frames: packFrames(state.frames),
    });

    const path = `${dir}/${fileName(name, lv)}`;
    backupOnce(dir, path);
    const ok = ObjC.classes.NSString.stringWithString_(payload)
        .writeToFile_atomically_encoding_error_(path, true, 4 /* NSUTF8 */, NULL);
    if (ok) {
        state.loaded = name;
        state.autoSaveName = name;
        persistLen = state.frames.length;
        persistAt = Date.now() + 1500;
    }
    return !!ok;
}

function load(name, levelIndex) {
    const dir = macroDirectory();
    if (dir === null) return false;

    const text = ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(
        `${dir}/${fileName(name, levelIndex)}`, 4, NULL);
    if (text === null) return false;

    try {
        const data = JSON.parse(text.toString());
        if (!Array.isArray(data.frames)) return false;
        stop();
        state.frames = unpackFrames(data.frames, data.version | 0);
        state.cutPending = false;
        resetTrace();
        state.cursor = 0;
        state.loaded = name;
        state.autoSaveName = name;
        state.complete = data.complete === true;
        state.resumeState = data.resumeState || null;
        state.shift = null;
        if (data.gates) {
            state.gates = cloneGates(data.gates);
        } else {
            resetGates(false);
            rebuildGatesFromFrames();
        }
        state.introSkipBaseline = data.introSkipBaseline !== undefined
            && data.introSkipBaseline !== null
            ? (data.introSkipBaseline | 0)
            : state.gates.skip;
        state.framesBaseline = null;
        state.gatesBaseline = null;
        // The level in the file NAME is the truth. The level field inside
        // could be stale, and trusting it saved a L19 run over a L18 file.
        const listed = levelIndex === undefined ? levelNumber() : levelIndex;
        if (typeof data.level === 'number' && (data.level | 0) !== listed) {
            log.warn(`${name}: file says level ${data.level}, listed under ${listed} - using ${listed}`, 'macro');
        }
        state.fileLevel = listed;
        forgetBackups();
        stampGateEvents();
        // Every take steps at 1/60. A saved stepSeconds must not retune the clock.
        frame.setStepHz(60);
        return true;
    } catch (err) {
        console.log(`[aerox-tas] macro ${name} is unreadable: ${err.message}`);
        return false;
    }
}

// Saved macros for a level, with enough detail for the panel to label them.
// The first write to a file in each take copies what was there to backups/,
// and DELETE moves the file to trash/. Nothing on disk is ever just gone.
const backedUp = {};

function stampName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stashFile(dir, path, folder) {
    const fm = ObjC.classes.NSFileManager.defaultManager();
    if (!fm.fileExistsAtPath_(path)) return false;
    const sub = `${dir}/${folder}`;
    fm.createDirectoryAtPath_withIntermediateDirectories_attributes_error_(sub, true, NULL, NULL);
    const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
    const dest = `${sub}/${base}.${stampName()}.json`;
    return folder === 'trash'
        ? !!fm.moveItemAtPath_toPath_error_(path, dest, NULL)
        : !!fm.copyItemAtPath_toPath_error_(path, dest, NULL);
}

function backupOnce(dir, path) {
    if (backedUp[path]) return;
    backedUp[path] = true;
    try {
        if (stashFile(dir, path, 'backups')) {
            log.info(`backed up ${path.slice(path.lastIndexOf('/') + 1)} before overwriting (backups/)`, 'macro');
        }
    } catch (err) { /* */ }
}

function forgetBackups() {
    Object.keys(backedUp).forEach(k => { delete backedUp[k]; });
}

// Write frames as a macro file without touching the loaded take (recovery).
function saveFrames(name, levelIndex, frames) {
    const dir = macroDirectory();
    if (dir === null || !frames.length) return false;
    const path = `${dir}/${fileName(name, levelIndex)}`;
    backupOnce(dir, path);
    const payload = JSON.stringify({
        version: FILE_VERSION,
        level: levelIndex,
        stepSeconds: 1 / 60,
        complete: false,
        recovered: true,
        frames: packFrames(frames),
    });
    return !!ObjC.classes.NSString.stringWithString_(payload)
        .writeToFile_atomically_encoding_error_(path, true, 4, NULL);
}

function takeLevel() {
    return typeof state.fileLevel === 'number' ? state.fileLevel : levelNumber();
}

function list(levelIndex) {
    const dir = macroDirectory();
    if (dir === null) return [];

    const n = levelIndex === undefined ? levelNumber() : levelIndex;
    const prefix = `level${String(n).padStart(3, '0')}__`;
    const files = ObjC.classes.NSFileManager.defaultManager()
        .contentsOfDirectoryAtPath_error_(dir, NULL);
    if (files === null) return [];

    const out = [];
    for (let i = 0; i < files.count(); i++) {
        const f = files.objectAtIndex_(i).toString();
        if (f.indexOf(prefix) !== 0 || !f.endsWith('.json')) continue;
        out.push(f.slice(prefix.length, -5));
    }
    return out.sort();
}

// Whether a saved macro reaches the finish, without disturbing what is loaded.
function isComplete(name, levelIndex) {
    const dir = macroDirectory();
    if (dir === null) return false;
    const text = ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(
        `${dir}/${fileName(name, levelIndex)}`, 4, NULL);
    if (text === null) return false;
    try { return JSON.parse(text.toString()).complete === true; } catch (err) { return false; }
}

function remove(name, levelIndex) {
    const dir = macroDirectory();
    if (dir === null) return false;
    const path = `${dir}/${fileName(name, levelIndex)}`;
    const ok = stashFile(dir, path, 'trash');
    if (ok) log.info(`moved ${fileName(name, levelIndex)} to trash/ (not erased)`, 'macro');
    return ok;
}

module.exports = {
    state, install, levelNumber, busy,
    record, play, seek, resume, refresh, refreshing, continueCapturing, landContinue, stop, clear, length, progress, describe, snapshot,
    resetVisual: resetVisualCam,
    abortPlayback, hooksQuiet,
    turboSteps,
    trimGates, syncPreviousFlags,
    shifting, shiftDelta, beginShift, shiftStep, cancelShift, applyShift,
    canRevertIntro, revertIntroShift,
    save, saveFrames, bitsf32, persist, load, list, isComplete, remove, macroDirectory, takeLevel,
};
