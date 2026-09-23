// Virtual tilt input, and the Original / Alternate controls distinction.
//
// processGameFrame produces exactly two floats that the whole game steers from,
// tiltSteer and tiltThrust, and it produces them one of two ways:
//
//   motionManager == NULL            ->  "Original Tilt controls"
//       tiltSteer  = accelY - calib.y
//       tiltThrust = calib.x - accelX
//       divisor    = (tiltThrust <= 0) ? 1 - calib.x : calib.x + 1
//       tiltThrust = tiltThrust / divisor
//
//   motionManager != NULL            ->  "Alternate Tilt controls"
//       attitude   = deviceMotion.attitude, relative to a stored reference
//       tiltSteer  = -roll
//       tiltThrust = -pitch
//
// That is the entire difference, and it is why Alt controls are "unbounded".
// The accelerometer branch feeds on gravity, so accelX/accelY live in [-1, 1]
// and the divisor normalises thrust to +/-1. The CoreMotion branch hands back
// Euler angles in *radians*, so the same two globals can reach +/-pi - roughly
// three times the force the rest of the game was tuned for. Nothing clamps
// them. Flipping the device ~170 degrees off the reference attitude is just the
// manual way of driving pitch close to pi; past 180 it wraps and you go
// backwards, exactly as the speedrun guide describes.
//
// The downstream physics is identical in both modes, including the 14.0 speed
// cap at `speedCap`, which clamps angular velocity and caps linear speed. Alt
// controls do not remove that cap; they reach it far faster and hold it through
// collisions because the input force is ~pi times larger.
//
// So we do not need to fake CoreMotion. Writing the EAGLView accel ivars with a
// zeroed calibration sets tiltSteer/tiltThrust directly (the divisor is exactly
// 1 either way), and the game cannot tell which branch produced them. The mode
// only decides how far we are *allowed* to push, which is what keeps the tool
// inside canonical bounds.

const mem = require('../core/mem');
const ivars = require('../core/ivars');
const frame = require('./frame');

const MODES = {
    // Peak magnitude each control scheme can reach unaided.
    original: { cap: 1.0, label: 'Original' },
    alternate: { cap: Math.PI, label: 'Alternate' },
};

const state = {
    enabled: false,
    // Fraction of the active mode's canonical cap, so full deflection is 1.0
    // whichever mode is live. This is the "tilt magnitude" setting.
    magnitude: 1.0,
    // The pad's up/left read backwards against the game's sign convention.
    invertSteer: false,
    invertThrust: false,
    // 'auto' follows the game's own setting; force a mode only for testing.
    mode: 'auto',
    held: { left: false, right: false, up: false, down: false },
    analog: null,     // { steer, thrust } in -1..1, or null
    override: null,   // { steer, thrust } as final tilt values; macro playback
    altBrake: false,  // make the in-game brake win against Alt's huge thrust
    brakeHeld: false,
};

let saved = null;

// The live control scheme, read from the game rather than from our own setting.
function activeMode() {
    if (state.mode !== 'auto') return state.mode;
    try {
        return mem.global('motionManager').readPointer().isNull() ? 'original' : 'alternate';
    } catch (err) {
        return 'original';
    }
}

function cap() {
    return MODES[activeMode()].cap;
}

function axes() {
    if (state.analog !== null) return state.analog;
    const h = state.held;
    return {
        steer: (h.right ? 1 : 0) - (h.left ? 1 : 0),
        thrust: (h.up ? 1 : 0) - (h.down ? 1 : 0),
    };
}

function brakeActive() {
    if (!state.altBrake) return false;
    if (state.brakeHeld) return true;
    try { return mem.global('buttonA').readU8() !== 0; } catch (err) { return false; }
}

// Write tiltSteer/tiltThrust for this tick. motionManager stays NULL so
// processGameFrame reads the ivars, not CoreMotion.
function drive(view, steer, thrust) {
    if (view === null || view === undefined) {
        try { view = frame.liveView(); } catch (err) { view = null; }
    }
    if (view === null) return false;
    let s = +steer;
    let t = +thrust;
    if (!isFinite(s)) s = 0;
    if (!isFinite(t)) t = 0;

    const motionPtr = mem.global('motionManager');
    const calibPtr = mem.global('calibration');
    if (saved === null) {
        saved = {
            motion: motionPtr.readPointer(),
            calib: calibPtr.readByteArray(12),
        };
    }
    motionPtr.writePointer(NULL);
    mem.writeVec3(calibPtr, 0, 0, 0);
    view.add(ivars.offsetOf('EAGLView', 'accelY')).writeFloat(s);
    view.add(ivars.offsetOf('EAGLView', 'accelX')).writeFloat(-t);
    view.add(ivars.offsetOf('EAGLView', 'accelZ')).writeFloat(0);
    return true;
}

function applyBeforeFrame(view) {
    if (view === null) return;
    const braking = brakeActive();
    if (braking) mem.global('buttonA').writeU8(1);
    if (!state.enabled && state.override === null && !braking) {
        let kb = false;
        try { kb = require('../ui/keyboard').state.enabled; } catch (err) { /* */ }
        if (!kb) {
            try { require('../tas/achievements').markDeviceTilt(); } catch (err) { /* */ }
            return;
        }
    }

    const limit = cap();
    let steer;
    let thrust;

    if (braking) {
        steer = 0;
        thrust = 0;
    } else if (state.override !== null) {
        steer = +state.override.steer;
        thrust = +state.override.thrust;
        if (!isFinite(steer)) steer = 0;
        if (!isFinite(thrust)) thrust = 0;
    } else {
        const a = axes();
        const scale = mem.clamp(state.magnitude, 0, 1) * limit;
        steer = (state.invertSteer ? a.steer : -a.steer) * scale;
        thrust = (state.invertThrust ? a.thrust : -a.thrust) * scale;
    }

    drive(view, steer, thrust);
}

function restoreAfterFrame() {
    if (saved === null) return;
    mem.global('motionManager').writePointer(saved.motion);
    mem.global('calibration').writeByteArray(saved.calib);
    saved = null;
}

function install() {
    applyBeforeFrame._tasName = 'input.before';
    restoreAfterFrame._tasName = 'input.after';
    frame.onBeforeFrame(applyBeforeFrame, 'level');
    frame.onAfterFrame(restoreAfterFrame, 'level');
}

// The tilt pad used to enter JS on every frame just to write two floats.
// Those writes now live in the native trampoline. This only runs when the
// pad, a key, or the magnitude changes, plus a slow refresh.
function publishNative() {
    let kb = false;
    try { kb = require('../ui/keyboard').state.enabled; } catch (err) { /* */ }
    if (state.override !== null) {
        frame.setNativeSteer(false, 0, 0, false, false);
        return;
    }
    const armed = !!(state.enabled || kb);
    const braking = !!state.brakeHeld;
    if (!armed && !braking && !state.altBrake) {
        frame.setNativeSteer(false, 0, 0, false, false);
        return;
    }
    let steer = 0;
    let thrust = 0;
    if (armed && !braking) {
        const a = axes();
        const scale = mem.clamp(state.magnitude, 0, 1) * cap();
        steer = (state.invertSteer ? a.steer : -a.steer) * scale;
        thrust = (state.invertThrust ? a.thrust : -a.thrust) * scale;
    }
    frame.setNativeSteer(armed || braking, steer, -thrust, braking, !!state.altBrake);
}

function setEnabled(value) {
    state.enabled = !!value;
    if (!state.enabled) {
        releaseAll();
        restoreAfterFrame();
    }
    publishNative();
    try { frame.syncHot(); } catch (err) { /* */ }
}

function altBrakeOn() { return !!state.altBrake; }

function setAltBrake(on) {
    state.altBrake = !!on;
    if (!state.altBrake) setBrake(false);
    else publishNative();
    return state.altBrake;
}

function setBrake(down) {
    state.brakeHeld = !!down;
    setButton('a', state.brakeHeld);
    publishNative();
}

function hold(direction, down) {
    if (state.held[direction] === undefined) return;
    state.held[direction] = !!down;
    state.analog = null;
    publishNative();
}

function releaseAll() {
    state.held.left = state.held.right = state.held.up = state.held.down = false;
    state.analog = null;
    publishNative();
}

function setAnalog(steer, thrust) {
    state.analog = { steer: mem.clamp(steer, -1, 1), thrust: mem.clamp(thrust, -1, 1) };
    publishNative();
}

function setOverride(steer, thrust) {
    state.override = (steer === null) ? null : { steer, thrust };
    publishNative();
}

// Live values the game is actually steering from, whether real or injected.
function current() {
    return {
        steer: mem.global('tiltSteer').readFloat(),
        thrust: mem.global('tiltThrust').readFloat(),
        buttonA: mem.global('buttonA').readU8() !== 0,
        buttonB: mem.global('buttonB').readU8() !== 0,
    };
}

function setButton(which, down) {
    mem.global(which === 'a' ? 'buttonA' : 'buttonB').writeU8(down ? 1 : 0);
}

function speedCap() {
    return mem.global('speedCap').readFloat();
}

module.exports = {
    MODES, state, install, setEnabled, hold, releaseAll, setAnalog, setOverride, publishNative,
    drive, current, setButton, setBrake, setAltBrake, altBrakeOn, brakeActive,
    axes, activeMode, cap, speedCap,
    modeLabel: () => MODES[activeMode()].label,
};
