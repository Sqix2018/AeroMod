// The single hook everything else hangs off.
//
// EAGLView::drawView is just `processGameFrame(self); renderGameFrame(self);`
// driven by a CADisplayLink, so skipping processGameFrame freezes simulation
// while the game keeps drawing - that is pause and frame advance.
//
// The game derives its delta time as `now - lastFrameTime`, then feeds that
// same value to Bullet, the intro timer, vertex anim, and runTimer. Writing
// lastFrameTime before pre-hooks is not enough: processGameFrame calls NSDate
// again after its own setup, so dt becomes 1/60 plus hook/setup time. Leftover
// accumulates and PLAY gets extra physics steps the recording never had.
// During a tick we pin NSDate to a TAS clock that advances exactly 1/60.
//
// This is an ObjC IMP swap, not a code patch - no instructions are rewritten.

const mem = require('../core/mem');

const DEFAULT_STEP = 1 / 60;
const MAX_CATCHUP = 2;     // 1x hitch recovery; matches Bullet maxSubSteps
const MAX_SPEED_TICKS = 3; // 2x / 3x extra processGameFrame calls this vsync
const MAX_TURBO = 8;       // JUMP/CONTINUE; 32 melted the device

const state = {
    installed: false,
    paused: false,
    pendingFrames: 0,
    speed: 1.0,
    fixedStep: true,
    stepSeconds: DEFAULT_STEP,
    frame: 0,
    lastDt: 0,
    view: null,       // the live EAGLView instance, captured on first frame
};

const preHooks = [];
const postHooks = [];
const beforeRenderHooks = [];
const renderHooks = [];
const pauseHooks = [];

let originalImp = null;
let swizzledImp = null; // retained so the callback is not collected
let callFrame = null;
let callRender = null;
let frameModule = null; // retained so the trampoline is not collected
let jsFlag = null;
let renderFlag = null;
let viewSlot = null;
let steerOn = null;
let steerY = null;
let steerX = null;
let steerBrake = null;
let steerAlt = null;
let steerOffX = null;
let steerOffY = null;
let steerOffZ = null;
let steerSavedMotion = null;
let steerCalibAddr = null;
let steerSavedCalib = null;
let steerSavedCalibBuf = null;
let playOn = null;
let playCursor = null;
let playLen = null;
let playPad = null;
let playTapeSlot = null;
let playPinYaw = null;
let playLastYaw = null;
let tapeBuf = null;
let clockOn = null;
let clockHot = null;
let clockHoldSlot = null;
let stepDt = null;
let nativeClock = false;
let idleLogAt = 0;
let originalRender = null;
let swizzledRender = null;
let lastRealTime = null;

let fastCap = 0;     // REFRESH / shift preview: ticks per vsync above the slider's 3
let extraSim = null; // () => extra 1/60 ticks this display frame (turbo seek)
let owed = 0;        // fractional 1/60 ticks owed vs wall clock
let lastWall = null;

let originalDateImp = null;
let swizzledDate = null;
let dateSel = null;
let dateMethodRef = null;
let originalStepImp = null;
let swizzledStep = null;
let stepMethodRef = null;
let clockHooksOn = false;
let clockHold = null; // NSDate returns this during a TAS tick
let tasClock = null;  // monotonic 1/60 clock, survives pause gaps

const costs = { n: 0, pre: 0, game: 0, hooks: {}, nextPrint: 0 };

function extraCount() {
    try { return extraSim === null ? 0 : extraSim() | 0; } catch (err) { return 0; }
}

let nsDate = null; // one class wrapper; ObjC.classes lookups per call add up

function wallNow() {
    if (nsDate === null) nsDate = ObjC.classes.NSDate;
    try {
        if (originalDateImp !== null && dateSel !== null) {
            return originalDateImp(nsDate, dateSel);
        }
    } catch (err) { /* */ }
    return nsDate.timeIntervalSinceReferenceDate();
}

function now() {
    return wallNow();
}

// The 1/60 lock is only for a macro take. Casual play, including the speed
// slider sitting at 1x, leaves NSDate and stepSimulation: on the game.
function macroTake() {
    try {
        const m = require('../tas/macro').state;
        if (m.mode === 'playing' || m.mode === 'recording'
            || m.mode === 'arming' || m.mode === 'lingering') return true;
        if (m.seekTo !== null || m.pendingMode) return true;
    } catch (err) { /* */ }
    return false;
}

function needsClockPin() {
    if (!macroTake()) return false;
    if (state.paused) return state.pendingFrames > 0;
    return true;
}

function bindClockHooks() {
    if (bindClockHooks.done) return;
    bindClockHooks.done = true;
    try {
        const dateMethod = ObjC.classes.NSDate['+ timeIntervalSinceReferenceDate'];
        if (dateMethod !== undefined) {
            originalDateImp = dateMethod.implementation;
            dateSel = ObjC.selector('timeIntervalSinceReferenceDate');
            dateMethodRef = dateMethod;
            swizzledDate = ObjC.implement(dateMethod, function (klass, sel) {
                if (clockHold !== null) return clockHold;
                return originalDateImp(klass, sel);
            });
        }
    } catch (err) {
        console.log(`[aerox-tas] NSDate clock pin failed: ${err.message}`);
    }
    try {
        const syn = ObjC.classes.synPhysics;
        const step = syn !== undefined ? syn['- stepSimulation:'] : undefined;
        if (step !== undefined) {
            originalStepImp = step.implementation;
            stepMethodRef = step;
            swizzledStep = ObjC.implement(step, function (handle, sel, dt) {
                const forced = state.fixedStep ? state.stepSeconds : dt;
                return originalStepImp(handle, sel, forced);
            });
        }
    } catch (err) {
        console.log(`[aerox-tas] stepSimulation pin failed: ${err.message}`);
    }
}

function setClockHooks(on) {
    bindClockHooks();
    // Native PLAY owns these IMPs. Swapping the JS versions back in is the leak.
    if (nativeClock) return;
    if (on === clockHooksOn) return;
    clockHooksOn = on;
    if (dateMethodRef !== null && originalDateImp !== null && swizzledDate !== null) {
        dateMethodRef.implementation = on ? swizzledDate : originalDateImp;
    }
    if (stepMethodRef !== null && originalStepImp !== null && swizzledStep !== null) {
        stepMethodRef.implementation = on ? swizzledStep : originalStepImp;
    }
}

function applyClock(dtOverride) {
    const wall = wallNow();
    const realDt = lastRealTime === null ? state.stepSeconds : wall - lastRealTime;
    lastRealTime = wall;

    const pin = needsClockPin();
    if (!pin) {
        if (clockHot !== null) clockHot.writeS32(0);
        clockHold = null;
        state.lastDt = mem.clamp(realDt, 0, 0.25);
        return;
    }

    const dt = dtOverride !== undefined
        ? dtOverride
        : (state.fixedStep ? state.stepSeconds : mem.clamp(realDt, 0, 0.25));
    state.lastDt = dt;

    // C pin: NSDate returns clock_hold and stepSimulation gets step_dt for the
    // whole processGameFrame. The JS date swizzle does not — hook time leaked
    // into Bullet and RECORD/PLAY drifted apart.
    if (installNativeClock() && clockHoldSlot !== null && clockHot !== null && stepDt !== null) {
        if (tasClock === null || !isFinite(tasClock)) {
            let seed = wall;
            try { seed = mem.global('lastFrameTime').readDouble(); } catch (err) { /* */ }
            // Whole-second seed: dt = hold - (hold - 1/60) rounds by the seed's
            // fraction bits, so a wall-clock seed gave a different dt each run.
            tasClock = Math.floor(isFinite(seed) ? seed : wall);
        } else if (state.fixedStep && clockHoldSlot !== null) {
            // Native PLAY advances clock_hold in C. A tip frame re-enters JS and
            // must continue that clock. Starting over from the last JS tick rewinds
            // every moving platform.
            const held = clockHoldSlot.readDouble();
            if (isFinite(held) && held > tasClock) tasClock = held;
        }
        if (state.fixedStep) tasClock += dt;
        else tasClock = wall;
        clockHoldSlot.writeDouble(tasClock);
        stepDt.writeFloat(dt);
        clockHot.writeS32(1);
        clockHold = tasClock;
        try { mem.global('lastFrameTime').writeDouble(tasClock - dt); } catch (err) { /* */ }
        return;
    }

    setClockHooks(true);
    if (state.fixedStep) {
        if (tasClock === null) tasClock = wall;
        tasClock += dt;
        clockHold = tasClock;
        mem.global('lastFrameTime').writeDouble(tasClock - dt);
    } else {
        clockHold = null;
        mem.global('lastFrameTime').writeDouble(wall - dt);
    }
}

function clockLabel() {
    if (nativeClock && clockOn !== null && clockOn.readS32() !== 0) return 'pin';
    return clockHooksOn ? 'pin' : 'game';
}

function menuIdle() {
    try {
        const macro = require('../tas/macro');
        const m = macro.state.mode;
        if (m === 'playing' || m === 'recording' || m === 'arming' || m === 'lingering') {
            return false;
        }
    } catch (err) { /* */ }
    try {
        const level = require('./level');
        if (level.restartPending()) return false;
        if (level.inLevel() && !level.inMainMenu()) return false;
    } catch (err) { /* */ }
    return true;
}

function skipHook(fn, idle, warpOn, snapOn) {
    const when = fn._tasWhen || 'always';
    if (when === 'always') return false;
    if (when === 'warp') return !warpOn;
    if (when === 'capture') return !snapOn;
    if (when === 'skin') {
        if (idle) return true;
        try { return require('../tas/skins').state.pending === null; } catch (err) { return true; }
    }
    if (idle) return true;
    return false;
}

function snapWanted() {
    if (state.paused) return true;
    try {
        const macro = require('../tas/macro');
        const m = macro.state.mode;
        if (m === 'recording') return true;
        if (m === 'playing' && macro.state.resumeAtEnd) return true;
    } catch (err) { /* */ }
    return false;
}

// The game thread's pool is not drained per tick. ObjC objects our hooks touch
// (autoreleased returns, class lookups) pile up there, so each hook section
// gets its own pool.
function poolOpen() { return mem.poolPush(); }

function poolClose(token) { mem.poolPop(token); }

let physicsMod = null;

function runTick(handle, selector, dtOverride) {
    applyClock(dtOverride);
    // Same condition as the clock pin: a TAS take skips the address-dependent
    // dbvt rebalance so RECORD and PLAY build the same broadphase.
    try {
        if (physicsMod === null) physicsMod = require('./physics');
        physicsMod.setDbvtGate(macroTake());
    } catch (err) { /* */ }

    const idle = menuIdle();
    let warpOn = false;
    try { warpOn = require('../tas/warplog').wantWatch(); } catch (err) { /* */ }
    const snapOn = snapWanted();
    if (idle && !warpOn) {
        try { require('../core/log').mark('idle'); } catch (err) { /* */ }
    }

    const t0 = wallNow();
    let pool = poolOpen();
    for (let i = 0; i < preHooks.length; i++) {
        if (skipHook(preHooks[i], idle, warpOn, snapOn)) continue;
        try { preHooks[i](handle); } catch (err) {
            console.log(`[aerox-tas] pre-frame hook: ${err.message}`);
        }
    }
    poolClose(pool);

    const t1 = wallNow();
    // Last write before the game. Pre-hook time must not be part of dt.
    if (nativeClock && clockHoldSlot !== null && clockHot !== null && stepDt !== null
        && tasClock !== null && isFinite(tasClock)) {
        const dt = state.lastDt;
        clockHoldSlot.writeDouble(tasClock);
        stepDt.writeFloat(dt);
        clockHot.writeS32(1);
        try { mem.global('lastFrameTime').writeDouble(tasClock - dt); } catch (err) { /* */ }
    }
    originalImp(handle, selector);
    state.frame += 1;
    clockHold = null;
    if (clockHot !== null) clockHot.writeS32(0);

    const t2 = wallNow();
    pool = poolOpen();
    for (let i = 0; i < postHooks.length; i++) {
        if (skipHook(postHooks[i], idle, warpOn, snapOn)) continue;
        const h0 = wallNow();
        try { postHooks[i](handle); } catch (err) {
            console.log(`[aerox-tas] post-frame hook: ${err.message}`);
        }
        const name = postHooks[i]._tasName || ('post' + i);
        costs.hooks[name] = (costs.hooks[name] || 0) + (wallNow() - h0);
    }
    poolClose(pool);

    costs.n += 1;
    costs.pre += t1 - t0;
    costs.game += t2 - t1;
    const wait = idle ? 8 : 2;
    if (costs.nextPrint === 0) {
        costs.nextPrint = t0 + wait;
    } else if (t0 >= costs.nextPrint) {
        const n = costs.n || 1;
        const parts = [];
        const names = Object.keys(costs.hooks);
        for (let i = 0; i < names.length; i++) {
            const avg = (costs.hooks[names[i]] / n) * 1000;
            if (avg >= 0.15) parts.push(`${names[i]}=${avg.toFixed(1)}`);
        }
        parts.sort();
        let phase = '?';
        let last = '';
        try { phase = require('./level').phase(); } catch (err) { /* */ }
        try { last = require('../core/log').crumb.hook; } catch (err) { /* */ }
        const line = `perf n=${n} pre=${((costs.pre / n) * 1000).toFixed(1)}ms`
            + ` game=${((costs.game / n) * 1000).toFixed(1)}ms`
            + (parts.length ? ` hooks ${parts.join(' ')}` : (idle ? ' hooks idle' : ' hooks ok'))
            + ` speed=${state.speed.toFixed(2)} ticks=${state.frame}`
            + ` phase=${phase} last=${last} clock=${clockLabel()}`
            + ` hook=on why=${hookReason() || 'on'}`;
        let memLine = '';
        try { memLine = require('../core/budget').suffix(); } catch (err) { /* */ }
        const full = memLine ? `${line}  ${memLine}` : line;
        collectGarbage('run', false);
        try { require('../core/log').breadcrumb(full); } catch (err) {
            console.log(`[aerox-tas] ${full}`);
        }
        costs.n = 0;
        costs.pre = 0;
        costs.game = 0;
        costs.hooks = {};
        costs.nextPrint = t0 + wait;
    }
}

function setExtraSim(fn) { extraSim = fn; }

// Each tick is still pinned to 1/60, so this only changes wall time. When the
// ticks outgrow the vsync the owed counter drops the excess (self-limiting).
function setFastCap(n) { fastCap = Math.max(0, Math.min(MAX_TURBO, n | 0)); }

function tickDt() {
    return state.fixedStep ? state.stepSeconds : undefined;
}

function resetClock() {
    owed = 0;
    lastWall = null;
    tasClock = null;
    clockHold = null;
}

// How many 1/60 processGameFrame calls this display frame.
// 1x tracks wall time so 120Hz and 30Hz both stay at 60 physics ticks/sec.
function ticksThisVsync() {
    let extra = 0;
    try { extra = extraSim === null ? 0 : extraSim() | 0; } catch (err) { extra = 0; }
    if (extra > 0) {
        resetClock();
        lastWall = now();
        let n = extra + 1;
        if (n > MAX_TURBO) n = MAX_TURBO;
        return n;
    }

    if (!state.fixedStep) {
        resetClock();
        return 1;
    }

    const t = now();
    if (lastWall === null) {
        lastWall = t;
        return 1;
    }

    let elapsed = t - lastWall;
    lastWall = t;
    if (!(elapsed > 0)) elapsed = 0;
    if (elapsed > 0.10) elapsed = 0.10;

    const rate = state.speed;
    if (!isFinite(rate) || rate <= 0) return 1;

    owed += elapsed / state.stepSeconds * rate;
    let n = owed | 0;
    if (n < 0) n = 0;

    const cap = rate > 1 ? Math.max(MAX_SPEED_TICKS, fastCap) : MAX_CATCHUP;
    if (n > cap) {
        n = cap;
        owed = 0;
    } else {
        owed -= n;
    }
    return n;
}

// Why the per-frame JS hook is on, or null when the game should run native.
// Speed and the 1/60 step do not count: those only apply inside a macro take.
function hookReason() {
    if (state.paused) return 'pause';
    if (state.pendingFrames > 0) return 'step';
    // Plain PLAY writes the tape from the trampoline. Entering JS here is
    // ~10MB/s. CONTINUE, seek, and record still need the hook.
    if (playOn !== null && playOn.readS32() !== 0) return null;
    try {
        const m = require('../tas/macro').state;
        if (m.mode !== 'idle' || m.seekTo !== null || m.pendingMode) {
            const extra = m.pendingMode ? `/${m.pendingMode}` : '';
            return `macro:${m.mode}${extra}`;
        }
    } catch (err) { /* */ }
    try {
        // The tilt pad and keyboard write accel from the native trampoline.
        // override is macro playback, which already has the hook on for the take.
        if (require('./input').state.override !== null) return 'override';
    } catch (err) { /* */ }
    if (steerOn === null) {
        try {
            const input = require('./input').state;
            if (input.enabled || input.brakeHeld) return 'input';
        } catch (err) { /* */ }
        try { if (require('../ui/keyboard').state.enabled) return 'keyboard'; } catch (err) { /* */ }
    }
    try {
        const dw = require('../tas/deathwarp');
        const probing = dw.autoOn() || dw.autoVoidOn();
        // AUTO samples on a timer. The per-frame hook is what walked rss
        // during a probe, on top of each loadLevel keeping the old scene.
        if (!probing && require('../tas/warplog').wantFrameWatch()) return 'warp';
    } catch (err) { /* */ }
    try { if (require('./ball').moving()) return 'move'; } catch (err) { /* */ }
    try { if (require('../tas/skins').state.pending) return 'skin'; } catch (err) { /* */ }
    try { if (require('./level').restartPending()) return 'restart'; } catch (err) { /* */ }
    return null;
}

function hookNeeded() { return hookReason() !== null; }

function liveView() {
    if (viewSlot !== null) {
        try {
            const p = viewSlot.readPointer();
            if (p !== null && !p.isNull()) state.view = p;
        } catch (err) { /* */ }
    }
    return state.view;
}

// Per-frame JS entry is what walked rss up. The game IMP stays native until a
// macro take, pause, or another tool needs it. Speed and the tilt pad do not.
let hookWhy = 'off';

function syncHot() {
    liveView();
    const why = hookReason();
    hookWhy = why || 'off';
    if (jsFlag === null) return why !== null;
    const on = why !== null ? 1 : 0;
    if (jsFlag.readS32() !== on) {
        jsFlag.writeS32(on);
        try { require('../core/log').debug(`hook ${on ? 'on' : 'off'}: ${hookWhy}`, 'frame'); } catch (err) { /* */ }
    }
    if (renderFlag !== null) {
        let draw = on;
        if (!draw && playOn !== null && playOn.readS32() !== 0) {
            try {
                const m = require('../tas/macro').state;
                if (m.smoothCam && m.mode === 'playing') draw = 1;
            } catch (err) { /* */ }
        }
        renderFlag.writeS32(draw);
    }
    return on === 1;
}

function pumpLevel() {
    if (jsFlag !== null && jsFlag.readS32() !== 0) return;
    if (playOn !== null && playOn.readS32() !== 0) return;
    let inLv = false;
    try {
        const level = require('./level');
        inLv = level.inLevel() && !level.inMainMenu();
    } catch (err) { return; }
    if (!inLv) return;
    const handle = liveView();
    for (let i = 0; i < postHooks.length; i++) {
        const when = postHooks[i]._tasWhen || 'always';
        if (when !== 'level') continue;
        try { postHooks[i](handle); } catch (err) { /* */ }
    }
}

// JS garbage (ObjC wrappers, NativePointers, strings) is native-backed and
// never triggers the collector on its own; without a forced gc rss walked up
// ~2.5MB/2s until jetsam. A gc costs 70-650ms, so only run it where a stall
// cannot be seen: hook off, paused, outside a TAS take (warp testing), or at
// arm before frame 0. Mid-take only as a jetsam guard.
const GC_IDLE_MS = 10000;
const GC_GUARD_MB = 150;
let lastGcAt = 0;
let lastGcRss = null;

function collectGarbage(why, force) {
    if (typeof gc !== 'function') return false;
    const nowMs = Date.now();
    let rss = null;
    try { rss = require('../core/budget').rssMB(); } catch (err) { /* */ }
    const guard = rss !== null && lastGcRss !== null && rss - lastGcRss > GC_GUARD_MB;
    if (!force && !guard && nowMs - lastGcAt < GC_IDLE_MS) return false;
    // Timer gc only where nobody is playing: paused, menus, victory screen.
    // In live play (warp probing too) a gc was a visible ~0.5s stall every
    // 10s; there only the +GC_GUARD_MB jetsam guard runs.
    let idle = state.paused;
    try {
        const lv = require('./level');
        if (!lv.inLevel() || lv.inMainMenu() || lv.complete()) idle = true;
    } catch (err) { /* */ }
    if (!force && !guard && !idle) return false;
    lastGcAt = nowMs;
    const t = wallNow();
    try { gc(); } catch (err) { return false; }
    let after = null;
    try { after = require('../core/budget').rssMB(); } catch (err) { /* */ }
    lastGcRss = after !== null ? after : rss;
    if (guard) {
        try { require('../core/log').debug(`gc guard (${why}) ${((wallNow() - t) * 1000).toFixed(0)}ms`, 'mem'); } catch (err) { /* */ }
    }
    return true;
}

function holdLog() {
    collectGarbage('idle', false);
    const nowMs = Date.now();
    if (nowMs - idleLogAt < 2000) return;
    idleLogAt = nowMs;
    let phase = '?';
    let memLine = '';
    try { phase = require('./level').phase(); } catch (err) { /* */ }
    try { memLine = require('../core/budget').suffix(); } catch (err) { /* */ }
    const line = `perf hold phase=${phase} hook=off clock=game`
        + (memLine ? `  ${memLine}` : '');
    try { require('../core/log').breadcrumb(line); } catch (err) {
        console.log(`[aerox-tas] ${line}`);
    }
}

// Tilt-pad writes. JS fills these when a direction or the magnitude changes.
// The trampoline applies them around the game frame so the pad never enters JS.
function setNativeSteer(on, accelY, accelX, brake, altBrake) {
    if (steerOn === null) return;
    const next = on ? 1 : 0;
    const prev = steerOn.readS32();
    steerOn.writeS32(next);
    if (steerY !== null) steerY.writeFloat(+accelY || 0);
    if (steerX !== null) steerX.writeFloat(+accelX || 0);
    if (steerBrake !== null) steerBrake.writeS32(brake ? 1 : 0);
    if (steerAlt !== null) steerAlt.writeS32(altBrake ? 1 : 0);
    if (prev !== next) {
        try { require('../core/log').debug(`steer ${next ? 'native' : 'off'}`, 'input'); } catch (err) { /* */ }
    }
}

function bindTrampoline(method, renderMethod) {
    if (callFrame !== null || originalImp === null || swizzledImp === null) return;
    jsFlag = Memory.alloc(4);
    jsFlag.writeS32(0);
    renderFlag = Memory.alloc(4);
    renderFlag.writeS32(0);
    viewSlot = Memory.alloc(Process.pointerSize);
    viewSlot.writePointer(NULL);
    steerOn = Memory.alloc(4);
    steerOn.writeS32(0);
    steerY = Memory.alloc(4);
    steerY.writeFloat(0);
    steerX = Memory.alloc(4);
    steerX.writeFloat(0);
    steerBrake = Memory.alloc(4);
    steerBrake.writeS32(0);
    steerAlt = Memory.alloc(4);
    steerAlt.writeS32(0);
    steerOffX = Memory.alloc(4);
    steerOffY = Memory.alloc(4);
    steerOffZ = Memory.alloc(4);
    try {
        const ivars = require('../core/ivars');
        steerOffX.writeS32(ivars.offsetOf('EAGLView', 'accelX') | 0);
        steerOffY.writeS32(ivars.offsetOf('EAGLView', 'accelY') | 0);
        steerOffZ.writeS32(ivars.offsetOf('EAGLView', 'accelZ') | 0);
    } catch (err) {
        steerOffX.writeS32(0x368);
        steerOffY.writeS32(0x36c);
        steerOffZ.writeS32(0x370);
    }
    steerSavedMotion = Memory.alloc(Process.pointerSize);
    steerSavedMotion.writePointer(NULL);
    steerCalibAddr = Memory.alloc(Process.pointerSize);
    steerSavedCalibBuf = Memory.alloc(12);
    steerSavedCalib = Memory.alloc(Process.pointerSize);
    steerSavedCalib.writePointer(steerSavedCalibBuf);
    try { steerCalibAddr.writePointer(mem.global('calibration')); } catch (err) { steerCalibAddr.writePointer(NULL); }
    playOn = Memory.alloc(4);
    playOn.writeS32(0);
    playCursor = Memory.alloc(4);
    playCursor.writeS32(0);
    playLen = Memory.alloc(4);
    playLen.writeS32(0);
    playPad = Memory.alloc(4);
    playPad.writeS32(0);
    playTapeSlot = Memory.alloc(Process.pointerSize);
    playTapeSlot.writePointer(NULL);
    playPinYaw = Memory.alloc(4);
    playPinYaw.writeS32(0);
    playLastYaw = Memory.alloc(4);
    playLastYaw.writeFloat(0);
    clockOn = Memory.alloc(4);
    clockOn.writeS32(0);
    clockHot = Memory.alloc(4);
    clockHot.writeS32(0);
    clockHoldSlot = Memory.alloc(8);
    clockHoldSlot.writeDouble(0);
    stepDt = Memory.alloc(4);
    stepDt.writeFloat(state.stepSeconds);
    let motionMgr = NULL;
    let buttonA = NULL;
    let buttonB = NULL;
    let cameraYawPtr = NULL;
    let lastFramePtr = NULL;
    let introPtr = NULL;
    let menuPtr = NULL;
    let completePtr = NULL;
    try { motionMgr = mem.global('motionManager'); } catch (err) { /* */ }
    try { buttonA = mem.global('buttonA'); } catch (err) { /* */ }
    try { buttonB = mem.global('buttonB'); } catch (err) { /* */ }
    try { cameraYawPtr = mem.global('cameraYaw'); } catch (err) { /* */ }
    try { lastFramePtr = mem.global('lastFrameTime'); } catch (err) { /* */ }
    try { introPtr = mem.global('introPlaying'); } catch (err) { /* */ }
    try { menuPtr = mem.global('menuFlag'); } catch (err) { /* */ }
    try { completePtr = mem.global('levelComplete'); } catch (err) { /* */ }
    try {
        const symbols = {
            orig_frame: originalImp,
            orig_render: originalRender || originalImp,
            js_frame: swizzledImp,
            js_render: swizzledRender || swizzledImp,
            js_on: jsFlag,
            render_on: renderFlag,
            live_view: viewSlot,
            steer_on: steerOn,
            accel_y: steerY,
            accel_x: steerX,
            brake_force: steerBrake,
            alt_brake: steerAlt,
            off_x: steerOffX,
            off_y: steerOffY,
            off_z: steerOffZ,
            motion_mgr: motionMgr,
            button_a: buttonA,
            calib_addr: steerCalibAddr,
            saved_motion: steerSavedMotion,
            saved_calib: steerSavedCalib,
            play_on: playOn,
            play_cursor: playCursor,
            play_len: playLen,
            play_pad: playPad,
            play_tape: playTapeSlot,
            play_pin_yaw: playPinYaw,
            play_last_yaw: playLastYaw,
            clock_on: clockOn,
            clock_hot: clockHot,
            clock_hold: clockHoldSlot,
            step_dt: stepDt,
            button_b: buttonB,
            camera_yaw: cameraYawPtr,
            last_frame_time: lastFramePtr,
            intro_playing: introPtr,
            menu_flag: menuPtr,
            level_complete: completePtr,
            orig_date: originalDateImp || originalImp,
            orig_step: originalStepImp || originalImp,
        };
        frameModule = new CModule(`
            extern void orig_frame(void *self, void *sel);
            extern void orig_render(void *self, void *sel);
            extern void js_frame(void *self, void *sel);
            extern void js_render(void *self, void *sel);
            extern int js_on;
            extern int render_on;
            extern void *live_view;
            extern int steer_on;
            extern float accel_y;
            extern float accel_x;
            extern int brake_force;
            extern int alt_brake;
            extern int off_x;
            extern int off_y;
            extern int off_z;
            extern void *motion_mgr;
            extern unsigned char button_a;
            extern void *calib_addr;
            extern void *saved_motion;
            extern void *saved_calib;
            extern int play_on;
            extern int play_cursor;
            extern int play_len;
            extern int play_pad;
            extern float *play_tape;
            extern int play_pin_yaw;
            extern float play_last_yaw;
            extern int clock_on;
            extern int clock_hot;
            extern double clock_hold;
            extern float step_dt;
            extern unsigned char button_b;
            extern float camera_yaw;
            extern double last_frame_time;
            extern unsigned char intro_playing;
            extern unsigned char menu_flag;
            extern unsigned char level_complete;
            extern double orig_date(void *self, void *sel);
            extern void orig_step(void *self, void *sel, float dt);

            void apply_steer(void *self);
            void restore_steer(void);

            double date_pin(void *self, void *sel) {
                if (clock_on && clock_hot) return clock_hold;
                return orig_date(self, sel);
            }

            void step_pin(void *self, void *sel, float dt) {
                if (clock_on && clock_hot) orig_step(self, sel, step_dt);
                else orig_step(self, sel, dt);
            }

            int row_needs_js(int cursor) {
                int ev;
                int prev;
                if (cursor >= play_len + play_pad) return 1;
                if (cursor < 0 || cursor >= play_len || play_tape == 0) return 1;
                // Overlays must go through JS so skip/dismiss (and recovery) can fire.
                if (intro_playing || menu_flag) return 1;
                ev = (int)play_tape[cursor * 5 + 4];
                prev = cursor > 0 ? (int)play_tape[(cursor - 1) * 5 + 4] : 0;
                if (ev != 0) return 1;
                if (intro_playing && (prev & 1)) return 1;
                if (menu_flag && (prev & 2)) return 1;
                return 0;
            }

            int native_play(void *self, void *sel) {
                int cursor = play_cursor;
                float steer;
                float thrust;
                float yaw;
                int buttons;
                if (row_needs_js(cursor)) {
                    if (clock_on) clock_hot = 1;
                    js_frame(self, sel);
                    clock_hot = 0;
                    return 1;
                }
                if (cursor < play_len) {
                    steer = play_tape[cursor * 5 + 0];
                    thrust = play_tape[cursor * 5 + 1];
                    buttons = (int)play_tape[cursor * 5 + 2];
                    yaw = play_tape[cursor * 5 + 3];
                    play_last_yaw = yaw;
                } else {
                    steer = 0.f;
                    thrust = 0.f;
                    buttons = 0;
                    yaw = play_last_yaw;
                }
                if (clock_on) {
                    clock_hold += step_dt;
                    last_frame_time = clock_hold - step_dt;
                    clock_hot = 1;
                }
                button_a = (buttons & 1) ? 1 : 0;
                button_b = (buttons & 2) ? 1 : 0;
                if (play_pin_yaw && !intro_playing && !level_complete) camera_yaw = yaw;
                accel_y = steer;
                accel_x = -thrust;
                brake_force = 0;
                alt_brake = 0;
                apply_steer(self);
                orig_frame(self, sel);
                clock_hot = 0;
                restore_steer();
                if (play_pin_yaw && !intro_playing && !level_complete) camera_yaw = yaw;
                play_cursor = cursor + 1;
                return 1;
            }

            void apply_steer(void *self) {
                unsigned char *c = (unsigned char *)calib_addr;
                unsigned char *s = (unsigned char *)saved_calib;
                int i;
                float y = accel_y;
                float x = accel_x;
                saved_motion = motion_mgr;
                if (s != 0 && c != 0) {
                    for (i = 0; i < 12; i++) s[i] = c[i];
                }
                motion_mgr = 0;
                if (c != 0) {
                    for (i = 0; i < 12; i++) c[i] = 0;
                }
                if (brake_force || (alt_brake && button_a)) {
                    y = 0.f;
                    x = 0.f;
                    button_a = 1;
                }
                *(float *)((unsigned char *)self + off_y) = y;
                *(float *)((unsigned char *)self + off_x) = x;
                *(float *)((unsigned char *)self + off_z) = 0.f;
            }

            void restore_steer(void) {
                unsigned char *c = (unsigned char *)calib_addr;
                unsigned char *s = (unsigned char *)saved_calib;
                int i;
                motion_mgr = saved_motion;
                if (s != 0 && c != 0) {
                    for (i = 0; i < 12; i++) c[i] = s[i];
                }
            }

            void call_frame(void *self, void *sel) {
                int poke;
                live_view = self;
                if (js_on) {
                    js_frame(self, sel);
                    return;
                }
                if (play_on && native_play(self, sel)) return;
                poke = steer_on || brake_force || (alt_brake && button_a);
                if (poke) apply_steer(self);
                orig_frame(self, sel);
                if (poke) restore_steer();
            }

            void call_render(void *self, void *sel) {
                if (render_on || js_on) js_render(self, sel);
                else orig_render(self, sel);
            }
        `, symbols);
        method.implementation = frameModule.call_frame;
        if (renderMethod !== undefined && originalRender !== null && swizzledRender !== null) {
            renderMethod.implementation = frameModule.call_render;
        }
        callFrame = frameModule.call_frame;
        callRender = frameModule.call_render;
        console.log('[aerox-tas] mem: frame hook off until a TAS tool needs it');
    } catch (err) {
        callFrame = null;
        callRender = null;
        frameModule = null;
        jsFlag = null;
        renderFlag = null;
        steerOn = null;
        console.log(`[aerox-tas] mem: native frame gate failed: ${err.message}`);
    }
}

function install() {
    if (state.installed) return true;
    if (!ObjC.available || ObjC.classes.EAGLView === undefined) {
        console.log('[aerox-tas] EAGLView not found; frame hook not installed');
        return false;
    }

    const method = ObjC.classes.EAGLView['- processGameFrame'];
    originalImp = method.implementation;

    swizzledImp = ObjC.implement(method, function (handle, selector) {
        state.view = handle;

        try {
            if (require('./level').restartPending()) {
                lastRealTime = now();
                return;
            }
        } catch (err) { /* level not loaded yet */ }

        // Outside a macro the game owns its clock. Pause still skips the sim.
        if (!macroTake()) {
            if (state.paused) {
                if (state.pendingFrames > 0) {
                    runTick(handle, selector);
                    state.pendingFrames -= 1;
                } else {
                    lastRealTime = now();
                }
                return;
            }
            runTick(handle, selector);
            return;
        }

        if (state.paused) {
            if (state.pendingFrames > 0) {
                runTick(handle, selector, tickDt());
                state.pendingFrames -= 1;
            } else {
                lastRealTime = now();
                collectGarbage('paused', false);
            }
            return;
        }

        if (extraCount() <= 0 && state.fixedStep && Math.abs(state.speed - 1) < 0.02) {
            runTick(handle, selector, tickDt());
            return;
        }

        const n = ticksThisVsync();
        if (n === 0) {
            lastRealTime = now();
            return;
        }
        const dt = tickDt();
        for (let i = 0; i < n; i++) {
            if (i > 0 && state.paused) break;
            runTick(handle, selector, dt);
        }
    });

    method.implementation = swizzledImp;
    bindClockHooks();

    const renderMethod = ObjC.classes.EAGLView['- renderGameFrame'];
    if (renderMethod !== undefined) {
        originalRender = renderMethod.implementation;
        swizzledRender = ObjC.implement(renderMethod, function (handle, selector) {
            const idle = menuIdle();
            let warpOn = false;
            try { warpOn = require('../tas/warplog').wantWatch(); } catch (err) { /* */ }
            const snapOn = snapWanted();
            for (let i = 0; i < beforeRenderHooks.length; i++) {
                if (skipHook(beforeRenderHooks[i], idle, warpOn, snapOn)) continue;
                try { beforeRenderHooks[i](handle); } catch (err) {
                    console.log(`[aerox-tas] before-render hook: ${err.message}`);
                }
            }
            originalRender(handle, selector);
            for (let i = 0; i < renderHooks.length; i++) {
                if (skipHook(renderHooks[i], idle, warpOn, snapOn)) continue;
                try { renderHooks[i](handle); } catch (err) {
                    console.log(`[aerox-tas] render hook: ${err.message}`);
                }
            }
        });
        renderMethod.implementation = swizzledRender;
    }

    bindTrampoline(method, renderMethod);
    setInterval(function () { mem.withPool(function () {
        try {
            const lv = require('./level');
            lv.noteScene();
            try { require('../tas/skins').menuGuard(); } catch (err) { /* */ }
            // Quitting to the title while TAS-paused (e.g. after CONTINUE
            // landed paused) left the game frozen in the menu. Always unpause.
            if (state.paused && lv.inMainMenu() && !lv.restartPending()) {
                setPaused(false);
                console.log('[aerox-tas] unpaused: back at the menu');
            }
        } catch (err) { /* */ }
        const on = syncHot();
        try { require('./input').publishNative(); } catch (err) { /* */ }
        try {
            if (playOn !== null && playOn.readS32() !== 0 && playCursor !== null) {
                require('../tas/macro').state.cursor = playCursor.readS32();
            }
        } catch (err) { /* */ }
        if (!on) {
            holdLog();
            pumpLevel();
        }
    }); }, 100);
    state.installed = true;
    return true;
}

// Put the original implementation back. After this the game runs its own clock
// and nothing in this tool observes or alters a frame.
function uninstall() {
    if (!state.installed || originalImp === null) return;

    const method = ObjC.classes.EAGLView['- processGameFrame'];
    method.implementation = originalImp;
    if (originalRender !== null) {
        const renderMethod = ObjC.classes.EAGLView['- renderGameFrame'];
        if (renderMethod !== undefined) renderMethod.implementation = originalRender;
    }

    state.installed = false;
    state.paused = false;
    state.pendingFrames = 0;
    state.speed = 1.0;
    resetClock();
    lastRealTime = null;
    swizzledImp = null;
    swizzledRender = null;
    originalRender = null;
    if (originalDateImp !== null) {
        try {
            const dateMethod = ObjC.classes.NSDate['+ timeIntervalSinceReferenceDate'];
            if (dateMethod !== undefined) dateMethod.implementation = originalDateImp;
        } catch (err) { /* */ }
        originalDateImp = null;
        swizzledDate = null;
        dateSel = null;
    }
    if (originalStepImp !== null) {
        try {
            const syn = ObjC.classes.synPhysics;
            const step = syn !== undefined ? syn['- stepSimulation:'] : undefined;
            if (step !== undefined) step.implementation = originalStepImp;
        } catch (err) { /* */ }
        originalStepImp = null;
        swizzledStep = null;
    }
}

// pre-frame hooks run after the clock is set and before the game simulates.
// `when`: 'always' (default), 'level' (skip main menu), 'warp' (WARP tools only).
function tagWhen(fn, when) {
    if (when) fn._tasWhen = when;
    return fn;
}
function onBeforeFrame(fn, when) { preHooks.push(tagWhen(fn, when)); }
function onAfterFrame(fn, when) { postHooks.push(tagWhen(fn, when)); }
function onBeforeRender(fn, when) { beforeRenderHooks.push(tagWhen(fn, when)); }
function onAfterRender(fn, when) { renderHooks.push(tagWhen(fn, when)); }
function onPauseChange(fn) { pauseHooks.push(fn); }

function setPaused(value) {
    const next = !!value;
    const prev = state.paused;
    state.paused = next;
    if (!state.paused) state.pendingFrames = 0;
    resetClock();
    syncHot();
    if (prev !== next) {
        for (let i = 0; i < pauseHooks.length; i++) {
            try { pauseHooks[i](next); } catch (err) { /* */ }
        }
    }
}

function togglePaused() { setPaused(!state.paused); return state.paused; }

function installNativeClock() {
    bindClockHooks();
    if (frameModule === null || clockHoldSlot === null || clockOn === null) return false;
    if (dateMethodRef === null || originalDateImp === null) return false;
    if (stepMethodRef === null || originalStepImp === null) return false;
    if (frameModule.date_pin === undefined || frameModule.step_pin === undefined) return false;
    if (!nativeClock) {
        dateMethodRef.implementation = frameModule.date_pin;
        stepMethodRef.implementation = frameModule.step_pin;
        nativeClock = true;
        console.log('[aerox-tas] time: NSDate and stepSimulation pinned to 1/60 during TAS ticks');
    }
    clockOn.writeS32(1);
    return true;
}

// Watch-only PLAY. The trampoline writes each row and pins 1/60, so
// processGameFrame does not enter JS. CONTINUE and seek stay on the hook.
function armNativePlay(rows, cursor, pinYaw, pad) {
    if (playOn === null || playTapeSlot === null || !rows || rows.length === 0) return false;
    stopNativePlay();
    const n = rows.length;
    tapeBuf = Memory.alloc(n * 5 * 4 + 16);
    for (let i = 0; i < n; i++) {
        const r = rows[i] || [];
        const at = tapeBuf.add(i * 20);
        at.writeFloat(+r[0] || 0);
        at.add(4).writeFloat(+r[1] || 0);
        at.add(8).writeFloat(+r[2] || 0);
        at.add(12).writeFloat(isFinite(+r[3]) ? +r[3] : 0);
        at.add(16).writeFloat(+r[4] || 0);
    }
    playTapeSlot.writePointer(tapeBuf);
    playLen.writeS32(n);
    playPad.writeS32(pad | 0);
    playCursor.writeS32(cursor | 0);
    playPinYaw.writeS32(pinYaw ? 1 : 0);
    playLastYaw.writeFloat(isFinite(+rows[n - 1][3]) ? +rows[n - 1][3] : 0);
    if (!installNativeClock()) {
        playOn.writeS32(0);
        return false;
    }
    playOn.writeS32(1);
    console.log(`[aerox-tas] macro: native play ${n}f (hook off)`);
    return true;
}

function stopNativePlay() {
    if (playOn !== null) playOn.writeS32(0);
    if (clockHot !== null) clockHot.writeS32(0);
}

function nativeCursor() {
    return playCursor === null ? 0 : playCursor.readS32();
}

function setNativeCursor(n) {
    if (playCursor !== null) playCursor.writeS32(n | 0);
}

function nativePlaying() {
    return playOn !== null && playOn.readS32() !== 0;
}

function advance(frames) {
    const n = frames === undefined ? 1 : (frames | 0);
    if (n !== 0) {
        try { require('../tas/achievements').noteFrameStep(n); } catch (err) { /* */ }
    }
    state.paused = true;
    state.pendingFrames += n;
    syncHot();
}

function setSpeed(value) {
    const n = Number(value);
    state.speed = (n === n && n > 0) ? mem.clamp(n, 0.02, 8.0) : 1.0;
    resetClock();
    syncHot();
}
function setFixedStep(value) { state.fixedStep = !!value; syncHot(); }
function setStepHz(hz) { state.stepSeconds = 1 / mem.clamp(hz, 1, 240); }

function runTimer() { return mem.global('runTimer').readFloat(); }
function cameraYaw() { return mem.global('cameraYaw').readFloat(); }

module.exports = {
    state, install, uninstall,
    onBeforeFrame, onAfterFrame, onBeforeRender, onAfterRender, onPauseChange,
    setPaused, togglePaused, advance, setExtraSim, syncHot, liveView, setNativeSteer, hookNeeded,
    armNativePlay, stopNativePlay, nativePlaying, nativeCursor, setNativeCursor,
    setSpeed, setFastCap, setFixedStep, setStepHz, resetClock,
    runTimer, cameraYaw, collectGarbage,
    effectiveFps: () => (state.lastDt > 0 ? 1 / state.lastDt : 0),
};
