// Bringing the tool back after CLOSE TAS.
//
// Gesture recognizers were a dead end. Flex also claims a multi-touch hold, and
// a recognizer has to win a negotiation we cannot reliably win. So this swizzles
// -[UIWindow sendEvent:], which is upstream of every recognizer in the app. We
// look at the touches, always call the original, and never consume anything.
//
// The gesture itself is two fingers in two different corners of the screen,
// held briefly. Three-finger hold is still accepted as a fallback, but corners
// do not collide with Flex and do not require three contacts on a moving game.

const log = require('../core/log');

const HOLD_MS = 400;
const CORNER = 88;
const TOUCHES_FALLBACK = 3;

// UITouch phases: 0 began, 1 moved, 2 stationary, 3 ended, 4 cancelled.
const ACTIVE_PHASES = { 0: true, 1: true, 2: true };

const state = {
    installed: false,
    armed: false,
    since: null,
    fired: false,
    onTrigger: null,
    peak: 0,
    lastNote: 0,
};

let original = null;

function cornerOf(x, y, width, height) {
    const left = x <= CORNER;
    const right = x >= width - CORNER;
    const top = y <= CORNER;
    const bottom = y >= height - CORNER;
    if (left && top) return 'tl';
    if (right && top) return 'tr';
    if (left && bottom) return 'bl';
    if (right && bottom) return 'br';
    return null;
}

function readTouches(event, window) {
    const out = { count: 0, corners: {} };
    try {
        const touches = event.allTouches();
        if (touches === null) return out;

        const all = touches.allObjects();
        const n = all.count();
        const bounds = window.bounds();
        const width = bounds[1][0];
        const height = bounds[1][1];

        for (let i = 0; i < n; i++) {
            const touch = all.objectAtIndex_(i);
            if (ACTIVE_PHASES[touch.phase()] !== true) continue;
            out.count += 1;
            const p = touch.locationInView_(window);
            const c = cornerOf(p[0], p[1], width, height);
            if (c !== null) out.corners[c] = true;
        }
    } catch (err) { /* never let this break event delivery */ }
    return out;
}

function fire(why) {
    if (state.fired) return;
    state.fired = true;
    log.info(`restore gesture: ${why}`, 'restore');
    if (state.onTrigger !== null) {
        try { state.onTrigger(); } catch (err) { log.error('restore.onTrigger', err); }
    }
}

function observe(event, window) {
    if (!state.armed) return;

    const seen = readTouches(event, window);
    if (seen.count > state.peak) state.peak = seen.count;

    const cornerCount = Object.keys(seen.corners).length;
    const twoCorners = cornerCount >= 2;
    const threeFingers = seen.count >= TOUCHES_FALLBACK;

    if (!twoCorners && !threeFingers) {
        state.since = null;
        state.fired = false;
        return;
    }

    const now = Date.now();
    if (state.since === null) {
        state.since = now;
        if (now - state.lastNote > 1500) {
            state.lastNote = now;
            log.info(twoCorners
                ? `two corners held (${Object.keys(seen.corners).join('+')}), keep holding`
                : `${seen.count} fingers down, keep holding`, 'restore');
        }
        return;
    }

    if (now - state.since >= HOLD_MS) {
        fire(twoCorners
            ? `two corners ${Object.keys(seen.corners).join('+')}`
            : `${seen.count}-finger hold`);
    }
}

function install(onTrigger) {
    state.onTrigger = onTrigger || null;
    if (state.installed) return true;

    try {
        const method = ObjC.classes.UIWindow['- sendEvent:'];
        original = method.implementation;

        method.implementation = ObjC.implement(method, function (handle, selector, event) {
            try {
                if (state.armed) observe(new ObjC.Object(event), new ObjC.Object(handle));
            } catch (err) { /* never let this break event delivery */ }
            return original(handle, selector, event);
        });

        state.installed = true;
        log.info('restore watcher installed on -[UIWindow sendEvent:]', 'restore');
        return true;
    } catch (err) {
        log.error('restore.install', err);
        return false;
    }
}

function uninstall() {
    if (!state.installed || original === null) return;
    try {
        ObjC.classes.UIWindow['- sendEvent:'].implementation = original;
    } catch (err) { log.error('restore.uninstall', err); }
    state.installed = false;
    original = null;
}

function arm() {
    state.armed = true;
    state.since = null;
    state.fired = false;
    state.peak = 0;
    log.info('restore armed: hold two corners, or three fingers', 'restore');
}

function disarm() {
    state.armed = false;
    state.since = null;
    state.fired = false;
}

function status() {
    return {
        installed: state.installed,
        armed: state.armed,
        holding: state.since === null ? 0 : Date.now() - state.since,
        peakTouches: state.peak,
    };
}

module.exports = { install, uninstall, arm, disarm, status, state, HOLD_MS, CORNER };
