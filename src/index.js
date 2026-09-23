// aerox-tas entry point.

require('./core/bridges'); // must run before anything uses ObjC (boot.js loads it first)
const mem = require('./core/mem');
const log = require('./core/log');
const storage = require('./core/storage');
const ball = require('./game/ball');
const frame = require('./game/frame');
const input = require('./game/input');
const savestate = require('./tas/savestate');
const macro = require('./tas/macro');
const rewind = require('./tas/rewind');
const deathwarp = require('./tas/deathwarp');
const warplog = require('./tas/warplog');
const ads = require('./tas/ads');
const scores = require('./tas/scores');
const splits = require('./tas/splits');
const achievements = require('./tas/achievements');
const skins = require('./tas/skins');
const scene = require('./game/scene');
const level = require('./game/level');
const panel = require('./ui/panel');
const hud = require('./ui/hud');
const dpad = require('./ui/dpad');
const keyboard = require('./ui/keyboard');
const minimap = require('./ui/minimap');
const picker = require('./ui/picker');
const power = require('./ui/power');
const widgets = require('./ui/widgets');
const camera = require('./game/camera');
const extents = require('./game/extents');
const timer = require('./ui/timer');

function banner() {
    console.log(`[aerox-tas] base ${mem.base}  version ${mem.version}`);
    if (!mem.exactVersion) {
        console.log('[aerox-tas] WARNING: no offset table for this build; ' +
                    'using the newest known set. Addresses are unverified.');
    }
}

let hooksInstalled = false;

function start() {
    if (hooksInstalled) {
        buildUi();
        return;
    }
    hooksInstalled = true;
    banner();
    log.installCrashHandler();

    if (!frame.install()) {
        console.log('[aerox-tas] aborting: frame hook unavailable');
        return;
    }
    // Order matters: macro's pre-frame hook publishes the replayed tilt that
    // input's pre-frame hook then writes into the EAGLView ivars. level's
    // post-frame hook runs a pending restart once the frame is finished.
    macro.install();
    rewind.install();
    input.install();
    ball.install();
    warplog.install();
    deathwarp.install();
    level.install();
    ads.install();
    scores.install();
    splits.install();
    achievements.install();
    skins.install();

    buildUi();

    // UI refresh is decoupled from the game loop so it keeps updating while paused.
    setInterval(function () {
        if (!power.state.enabled) return;
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                hud.refresh();
                timer.refresh();
                dpad.refresh();
                panel.refresh();
                minimap.refresh();
                // A non-finite camera yaw survives a level change and leaves the
                // menu rendering white, so sweep for it rather than wait for a
                // report that the game "went blank".
                ball.scrubNaN();
            } catch (err) { /* view torn down */ }
        });
    }, 66);
}

// The window can come later than the hooks (Frida Gadget starts us while
// the app is still launching). Retry only this part - calling start() again
// used to install every hook a second time.
function buildUi() {
    ObjC.schedule(ObjC.mainQueue, function () {
        try {
            const window = widgets.keyWindow();
            if (window === null) {
                console.log('[aerox-tas] no key window yet; retrying in 1s');
                setTimeout(buildUi, 1000);
                return;
            }
            power.build(window, {
                onRestore: function () {
                    try { picker.close(); } catch (err) { /* */ }
                    try { dpad.setVisible(false); } catch (err) { /* */ }
                    try { dpad.setBrakeVisible(input.altBrakeOn()); } catch (err) { /* */ }
                    try { hud.setVisible(false); } catch (err) { /* */ }
                    try { minimap.setVisible(false); } catch (err) { /* */ }
                    try {
                        if (panel.ui.panel !== null) panel.ui.panel.setHidden_(true);
                    } catch (err) { /* */ }
                    panel.setStatus('AeroMod restored');
                },
            });
            hud.build(window);
            timer.build(window);
            minimap.build(window);
            picker.build(window);
            panel.build();
            [hud.box(), minimap.ui.box, picker.ui.root, dpad.box(),
                dpad.brakeBox(), timer.ui.timer, timer.ui.splitBox, timer.ui.mark]
                .forEach(v => power.register(v));
            console.log('[aerox-tas] ready - tap the AeroMod pill to open the panel');
            try { require('./boot').bootLog('ready - AeroMod pill is up'); } catch (e) { /* */ }
        } catch (err) {
            console.log(`[aerox-tas] UI build failed: ${err.message}\n${err.stack}`);
            try { require('./boot').bootLog(`UI build failed: ${err.message}`); } catch (e) { /* */ }
        }
    });
}

if (ObjC.available) {
    setTimeout(start, 800);
} else {
    console.log('[aerox-tas] ObjC runtime unavailable');
    try { require('./boot').bootLog('ObjC runtime unavailable - not starting'); } catch (e) { /* */ }
}

// Console API for scripted work.
globalThis.tas = {
    mem, ball, frame, input, savestate, macro, rewind, deathwarp, warplog, scene, level, ads, power,
    camera, extents, picker, hud, minimap, log, scores, splits, timer,
    achievements, skins,
    pause: () => frame.setPaused(true),
    resume: () => frame.setPaused(false),
    step: (n) => rewind.step(n === undefined ? 1 : n),
    back: (n) => rewind.back(n),
    jump: (n) => rewind.jump(n),
    speed: (x) => frame.setSpeed(x),
    save: (i) => savestate.save(i),
    load: (i) => savestate.load(i),
    tp: (x, y, z) => ball.teleport(x, y, z),
    slide: (x, y, z) => ball.slideTo(x, y, z),
    aabb: () => warplog.treeHint(),
    pos: () => ball.position(),
    mode: () => input.activeMode(),

    // Macros
    rec: (name) => macro.record({ name }),
    play: () => macro.play(),
    playClean: () => timer.playClean(),
    resume: () => macro.resume(),
    stop: () => { macro.stop(); timer.endClean(); },
    saveMacro: (name) => macro.save(name),
    loadMacro: (name) => macro.load(name),
    macros: () => macro.list(),
    restart: () => level.restart(),
    phase: () => level.phase(),
    split: () => splits.manualSplit(),

    // Whole-tool power
    off: () => power.disable(widgets.keyWindow()),
    on: () => power.enable(),
    noAds: (v) => ads.setBlocking(v !== false),
    logs: () => log.tail(40),
    logFile: () => ({ documents: log.documentsFile(), tmp: log.FILE_TMP }),
    mem: () => require('./core/budget').suffix(),

    // Death warp
    // Simulates the armed-respawn AABB traversal on the live static tree;
    // scores it against recorded first-after-void deaths, prints a map.
    warp: () => deathwarp.evaluate(),
    movables: () => deathwarp.movables(),
    toMovable: () => deathwarp.goMovable(),
    forceVoid: (kind) => deathwarp.forceVoid(kind),
    clearProbes: () => warplog.clearProbes(),
    autoVoid: (on) => deathwarp.setAutoVoid(on !== false),
    dropY: (y) => (y === undefined ? deathwarp.objectDropY() : deathwarp.setObjectDropY(y)),
    objects: (filter) => scene.dump(filter),

    // Display
    show: (what, on) => ({
        hud: hud.setVisible, map: minimap.setVisible,
        timer: timer.setTimerVisible, splits: timer.setSplitsVisible,
        segment: timer.setSegmentVisible,
    })[what](on !== false),
    pick: (fn) => picker.open(fn),

    keyboard,
};
