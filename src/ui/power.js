// Turning the whole tool off, and getting it back.
//
// "Off" has to mean genuinely off, not hidden: if this ships inside an injected
// IPA then anyone who is not running a TAS should be playing a stock game. So
// disabling restores the original processGameFrame implementation, puts back
// every global the tool touches, un-swizzles the ad gate, and removes the UI.
// With it off there is no hook on the frame, no clock manipulation and no input
// injection - nothing left that could influence a run.
//
// Getting back in is handled by ui/restore.js, which counts touches inside
// -[UIWindow sendEvent:] rather than using a gesture recognizer. See that file
// for why; the short version is that a recognizer has to win a negotiation
// against every other recognizer in the app and Flex wins it instead.
//
// The launcher pill stays visible while the TAS is on, except during PLAY
// CLEAN, which hides everything except a small TAS watermark so a recording
// is still identifiable.

const theme = require('./theme');
const w = require('./widgets');
const log = require('../core/log');
const frame = require('../game/frame');
const input = require('../game/input');
const macro = require('../tas/macro');
const ads = require('../tas/ads');
const deathwarp = require('../tas/deathwarp');
const restore = require('./restore');
const scores = require('../tas/scores');
const skins = require('../tas/skins');
const timer = require('./timer');

const state = { enabled: true, notice: null };

// Views the tool owns. `restore: true` comes back with the tool; everything
// else stays hidden so a reopen is the TAS pill and nothing else.
const owned = [];
let onRestore = null;

function register(view, options) {
    if (view === null || view === undefined) return;
    owned.push({ view, restore: !!(options && options.restore) });
}

function setOwnedHidden(hidden) {
    owned.forEach(entry => {
        try { entry.view.setHidden_(hidden); } catch (err) { /* torn down */ }
    });
}

function resetToLauncher() {
    owned.forEach(entry => {
        try { entry.view.setHidden_(!entry.restore); } catch (err) { /* torn down */ }
    });
}

// The explanation shown when the tool is closed. Sized generously: the text is
// the only instruction for getting back in, so it must never clip.
function showNotice(window) {
    const bounds = window.bounds();
    const width = Math.min(380, bounds[1][0] - 40);
    const height = Math.min(248, bounds[1][1] - 40);
    const x = (bounds[1][0] - width) / 2;
    const y = (bounds[1][1] - height) / 2;

    const card = w.view([[x, y], [width, height]], theme.background);

    card.addSubview_(w.label([[20, 20], [width - 40, 26]], 'AeroMod disabled',
        { size: 18, center: true }));

    card.addSubview_(w.label([[20, 54], [width - 40, 44]],
        'The game is running unmodified. No frame hook, no input injection, ' +
        'nothing altered.',
        { size: 13, color: theme.textDim, lines: 3, center: true }));

    card.addSubview_(w.label([[20, 108], [width - 40, 50]],
        'To bring AeroMod back:\nhold two corners of the screen at once.',
        { size: 15, color: theme.accent, lines: 2, center: true }));

    card.addSubview_(w.label([[20, 162], [width - 40, 26]],
        'Or run tas.on() from the Frida console.',
        { size: 11, color: theme.textDim, center: true }));

    card.addSubview_(w.button([[20, height - 64], [width - 40, theme.TOUCH]], 'OK',
        function () {
            card.removeFromSuperview();
            state.notice = null;
        }, { size: 16, background: theme.accentDim }));

    window.addSubview_(card);
    window.bringSubviewToFront_(card);
    state.notice = card;
}

function disable(window) {
    if (!state.enabled) return false;

    // Put the live HeroBall back before any of the hooks go away.
    try { skins.restore(); } catch (err) { /* */ }

    // Stop anything that is mid-flight before unhooking.
    macro.stop();
    input.setEnabled(false);
    input.setOverride(null);
    input.setBrake(false);
    input.setButton('a', false);
    input.setButton('b', false);
    deathwarp.setWatching(false);

    // Put the game's own clock and ad gate back.
    frame.setPaused(false);
    frame.setSpeed(1.0);
    frame.uninstall();
    ads.setBlocking(false);
    ads.uninstall();
    scores.uninstall();
    timer.powerOff();

    setOwnedHidden(true);
    state.enabled = false;

    restore.arm();

    if (window !== null && window !== undefined) showNotice(window);
    log.info('disabled - the game is unmodified. Hold two corners to restore, '
        + 'or run tas.on()', 'power');
    return true;
}

function enable() {
    if (state.enabled) return false;

    restore.disarm();
    frame.install();
    ads.setBlocking(true);
    scores.install();
    // Only the launcher pill. Opening every owned view used to dump the
    // teleport grid, warp ray and HUD onto the screen at once.
    resetToLauncher();
    state.enabled = true;

    if (state.notice !== null) {
        state.notice.removeFromSuperview();
        state.notice = null;
    }
    log.info('re-enabled', 'power');
    if (onRestore !== null) {
        try { onRestore(); } catch (err) { log.error('power.onRestore', err); }
    }
    return true;
}

function build(window, options) {
    const opts = options || {};
    onRestore = opts.onRestore || null;
    // Installed once, up front, but only *armed* while the tool is off, so there
    // is no per-event work during normal play.
    restore.install(enable);
}

module.exports = {
    state, build, register, disable, enable, resetToLauncher, showNotice, restore,
};
