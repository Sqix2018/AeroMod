// The level lifecycle, and the two taps that decide what state a run starts in.
//
// A level goes through a fixed sequence, and a macro is only reproducible if it
// starts at the top of it and hits the same transitions on the same frames:
//
//   loadLevel:            inLevel = 1, introPlaying = 1, levelComplete = 0
//   |                     the opening camera flies around the level
//   |                     *** physics is running: platforms are already moving
//   |
//   [tap]  touchesEnded:  introPlaying = 0, camera cuts to sceneCameras[0]
//   |                     requires introTimer > 0, so not on the very first frames
//   |
//   StartPoint overlap    menuFlag = 1, readyPrompt = 1, inPlay = 1,
//   |                     started = 1, runTimer = 0, "Get Ready!" on screen
//   |                     *** everything is paused here
//   |
//   [tap]  touchesBegan:  clears the text quad, runs menu action -4,
//   |                     readyPrompt = 0, menuFlag = 0  -> the run starts
//   |
//   playing               TextTrigger tips set menuFlag = 1 again mid-run; the
//                         run timer stops until another tap clears them
//
// The first tap is the one that matters. The level simulates all through the
// fly-around, so skipping after two seconds and skipping after twenty give
// genuinely different platform positions. The second tap matters much less,
// because everything is frozen behind the "Get Ready!" prompt.
//
// Rather than record raw touches and try to replay synthetic UITouch objects,
// the macro records the *transitions* (introPlaying 1->0, menuFlag 1->0) and
// replays them by running the same code the touch handlers run. That captures
// the effect of every tap that changes game state, and it is indifferent to
// where on the screen the tap landed.

const mem = require('../core/mem');
const frame = require('./frame');

function flag(name) {
    try { return mem.global(name).readU8() !== 0; } catch (err) { return false; }
}

function inLevel() { return flag('inLevel'); }
function introPlaying() { return flag('introPlaying'); }
function messageUp() { return flag('menuFlag'); }
function readyPrompt() { return flag('readyPrompt'); }
function inPlay() { return flag('inPlay'); }
function started() { return flag('started'); }
function complete() { return flag('levelComplete'); }
function inMainMenu() { return flag('mainMenu'); }
function playable() {
    return inLevel() && !inMainMenu() && !complete() && !restartPending();
}

function levelNumber() {
    try { return mem.global('levelNumber').readS32(); } catch (err) { return -1; }
}

// The level the loaded scene was built from. DAT_levelNumber is not that: a
// death warp bumps it before the scene unloads, and menus change it. It is
// right at load time (loadLevel: reads it), so capture it when the scene
// pointer changes or an intro starts, and keep it until the next load.
const loaded = { scene: null, level: -1, intro: false };

function noteScene() {
    try {
        const sc = mem.global('scene').readPointer();
        const key = sc.isNull() ? null : sc.toString();
        const intro = introPlaying();
        if (key !== loaded.scene || (intro && !loaded.intro)) {
            loaded.scene = key;
            loaded.level = key === null ? -1 : levelNumber();
        }
        loaded.intro = intro;
    } catch (err) { /* */ }
}

function loadedLevel() {
    noteScene();
    if (loaded.level >= 0 && inLevel() && !inMainMenu()) return loaded.level;
    return levelNumber();
}

function runTimer() {
    try { return mem.global('runTimer').readFloat(); } catch (err) { return 0; }
}

// One word for where the level is, for the HUD and for macro gating.
function phase() {
    if (!inLevel()) return inMainMenu() ? 'menu' : 'none';
    if (complete()) return 'complete';
    if (introPlaying()) return 'intro';
    if (messageUp()) return started() ? 'message' : 'ready';
    return 'playing';
}

function firstSceneCamera(sceneObj) {
    try {
        const cameras = sceneObj.sceneCameras();
        if (cameras === null || cameras === undefined) return null;
        if (typeof cameras.count === 'function') {
            return cameras.count() > 0 ? cameras.objectAtIndex_(0) : null;
        }
        const p = cameras.handle !== undefined ? cameras.handle : cameras;
        if (p.isNull && p.isNull()) return null;
        const cam = p.readPointer();
        return (cam.isNull && cam.isNull()) ? null : cam;
    } catch (err) {
        return null;
    }
}

// Exactly what touchesEnded: does when you tap through the fly-around.
// force: PLAY retries after the recorded skip frame if introTimer is still <= 0.
function skipIntro(force) {
    if (!inLevel() || inMainMenu() || !introPlaying()) return false;
    // The game refuses the skip until this timer has ticked past zero.
    if (mem.global('introTimer').readFloat() <= 0) {
        if (!force) return false;
        try { mem.global('introTimer').writeFloat(0.05); } catch (err) { return false; }
    }

    const scenePtr = mem.global('scene').readPointer();
    if (scenePtr.isNull()) return false;

    const s = new ObjC.Object(scenePtr);
    try {
        const cam = firstSceneCamera(s);
        if (cam !== null) s.setActiveCamera_(cam);
    } catch (err) {
        console.log(`[aerox-tas] skipIntro camera: ${err.message}`);
    }

    try {
        const flashPtr = mem.global('flashModel').readPointer();
        if (!flashPtr.isNull()) {
            const materials = new ObjC.Object(flashPtr).modelMaterials();
            if (materials !== null && !materials.isNull()) {
                new ObjC.Object(materials.readPointer()).setNodeFrameTimeFloat_(0);
            }
        }
    } catch (err) { /* flash is cosmetic */ }

    mem.global('flashState').writeU8(1);
    mem.global('introPlaying').writeU8(0);
    setCurrentMenu(0);
    return true;
}

// Exactly what touchesBegan: does when you tap a "Get Ready!" or tip message.
function dismissMessage(view) {
    if (!inLevel() || !messageUp()) return false;
    // Real pause overlay owns touches; do not clear it as a tip.
    if (inMainMenu() && currentMenu() === 6) return false;

    // Blank the text quad by clearing its first mesh pointer.
    const textPtr = mem.global('textModel').readPointer();
    if (!textPtr.isNull()) {
        const meshes = new ObjC.Object(textPtr).modelMeshes();
        if (meshes !== null && !meshes.isNull() && !meshes.readPointer().isNull()) {
            meshes.writePointer(NULL);
        }
    }

    // The "Get Ready!" prompt carries a pending menu action; tips do not.
    if (flag('readyPrompt') && view !== null && view !== undefined) {
        try { new ObjC.Object(view).customMenuSelectFunctions_(-4); } catch (err) {
            console.log(`[aerox-tas] ready prompt action failed: ${err.message}`);
        }
        mem.global('readyPrompt').writeU8(0);
        try { mem.global('inPlay').writeU8(1); } catch (err) { /* */ }
    }

    mem.global('menuFlag').writeU8(0);
    return true;
}

// Reload the current level from scratch. loadLevel: unloads first, so this is a
// clean restart back to the top of the sequence above.
//
// Deferred to the end of a frame: it tears down and rebuilds the scene graph and
// the Bullet world, which is not something to do underneath the running frame.
let pendingRestart = null;
let settleFrames = 0;

function setLevelNumber(n) {
    if (n === undefined || n === null || n < 0) return false;
    try {
        mem.global('levelNumber').writeS32(n);
        return true;
    } catch (err) {
        return false;
    }
}

// Menu actions from customMenuSelectFunctions:. -5 is "Play next level"
// (loadLevel_ of DAT_levelNumber). -7 unloads and returns to the main menu.
function menuAction(code) {
    const view = frame.liveView();
    if (view === null) return false;
    try {
        new ObjC.Object(view).customMenuSelectFunctions_(code);
        return true;
    } catch (err) {
        console.log(`[aerox-tas] menu action ${code} failed: ${err.message}`);
        return false;
    }
}

function playCurrent() {
    const ok = menuAction(-5);
    // loadLevel: does not reset currentMenu. After "Play next level" it is
    // still 13 (victory), and touchesBegan: skips the in-game pause button.
    setCurrentMenu(0);
    try { mem.global('mainMenu').writeU8(0); } catch (err) { /* */ }
    return ok;
}

function goMainMenu() { return menuAction(-7); }

// Main-menu Play. Clears mainMenu then loadLevel: of DAT_levelNumber.
// customMenuSelectFunctions_(-5) is the victory "next level" button; calling
// it from the title screen with DAT 0 looks up Level000.scn and crashes.
function startGame() {
    const view = frame.liveView();
    if (view === null) return false;
    try {
        new ObjC.Object(view).startGame();
        return true;
    } catch (err) {
        console.log(`[aerox-tas] startGame failed: ${err.message}`);
        return false;
    }
}

let cachedMenu = { view: null, mgr: null };

function menuManagerOf(view) {
    if (view === null) return null;
    if (cachedMenu.view === view && cachedMenu.mgr !== null) return cachedMenu.mgr;
    const o = new ObjC.Object(view);
    let mgr = null;
    try {
        const m = o.menuManager();
        if (m !== null && m !== undefined && !(m.isNull && m.isNull())) mgr = m;
    } catch (err) { /* no accessor */ }
    if (mgr === null) {
        try {
            const raw = o.$ivars.menuManager;
            if (raw === null || raw === undefined) {
                cachedMenu = { view, mgr: null };
                return null;
            }
            mgr = new ObjC.Object(raw.handle === undefined ? raw : raw.handle);
        } catch (err) {
            cachedMenu = { view, mgr: null };
            return null;
        }
    }
    cachedMenu = { view, mgr };
    return mgr;
}

function setCurrentMenu(index) {
    const mgr = menuManagerOf(frame.state.view);
    if (mgr === null) return false;
    try {
        mgr.setCurrentMenu_(index);
        return true;
    } catch (err) {
        console.log(`[aerox-tas] setCurrentMenu failed: ${err.message}`);
        return false;
    }
}

function currentMenu() {
    const mgr = menuManagerOf(frame.state.view);
    if (mgr === null) return -1;
    try { return mgr.currentMenu() | 0; } catch (err) { return -1; }
}

// runInGameMenu sets currentMenu=6 and mainMenu=1. Tips / Get Ready set
// menuFlag (and often leave currentMenu at 6) but not mainMenu — those must
// not cancel PLAY, and must not block detecting the real pause overlay.
function pausedInGame() {
    if (currentMenu() !== 6) return false;
    return inMainMenu();
}

// runInGameMenu sets menu 6, menuFlag, and mainMenu. loadLevel does not
// clear currentMenu, so RECORD/PLAY used to leave the pause overlay up.
function dismissPauseMenu() {
    try { mem.global('menuFlag').writeU8(0); } catch (err) { /* */ }
    try { mem.global('mainMenu').writeU8(0); } catch (err) { /* */ }
    try { mem.global('flashState').writeU8(0); } catch (err) { /* */ }
    const ok = setCurrentMenu(0);
    const mgr = menuManagerOf(frame.state.view);
    if (mgr !== null) {
        try { mgr.resetAnimations(); } catch (err) { /* */ }
    }
    try { frame.setPaused(false); } catch (err) { /* */ }
    return ok;
}

function restart(onDone, levelOverride) {
    const n = (levelOverride === undefined || levelOverride === null)
        ? levelNumber() : levelOverride;
    pendingRestart = { level: n, onDone: onDone || null, running: false, view: null };
    try { require('./scene').invalidateDynamics(); } catch (err) { /* */ }
    try { frame.syncHot(); } catch (err) { /* */ }
    console.log(`[aerox-tas] level: restart queued for ${n} (after this frame draws)`);
    setTimeout(function () {
        if (pendingRestart !== null && !pendingRestart.running) applyRestart();
    }, 50);
    return true;
}

function restartPending() { return pendingRestart !== null; }
function settling() { return settleFrames > 0; }

function applyRestart() {
    if (pendingRestart === null || pendingRestart.running) return;
    const view = pendingRestart.view || frame.liveView();
    if (view === null) return;
    pendingRestart.running = true;
    const request = pendingRestart;

    setTimeout(function () {
        ObjC.schedule(ObjC.mainQueue, function () {
            const fromMenu = inMainMenu();
            const wasComplete = complete();
            const inLv = inLevel();
            try { require('./scene').invalidateDynamics(); } catch (err) { /* */ }
            try {
                const phys = require('./physics');
                const detached = phys.detachBall('load');
                phys.normalize('load');
                console.log(`[aerox-tas] level: physics reset for load${detached ? ' (ball detached)' : ''}`);
            } catch (err) { /* */ }
            try {
                mem.global('levelNumber').writeS32(request.level);
                mem.global('levelComplete').writeU8(0);
            } catch (err) { /* */ }

            // loadLevel: looks up Level%03d.scn. Index 0 is not a level.
            // From the title screen, startGame is the Play button. From
            // victory, -5 is Next Level. Direct loadLevel: only when already
            // in a running level.
            if (fromMenu || !inLv) {
                console.log(`[aerox-tas] level: startGame ${request.level}`);
                try {
                    startGame();
                } catch (err) {
                    console.log(`[aerox-tas] startGame ${request.level} failed: ${err.message}`);
                    pendingRestart = null;
                    if (request.onDone !== null) request.onDone(false);
                    return;
                }
                try { require('./scene').invalidateDynamics(); } catch (err) { /* */ }
                try { require('../tas/rewind').reset('startGame'); } catch (err) { /* */ }
                try { require('../tas/warplog').resetLoad('startGame'); } catch (err) { /* */ }
                try { require('./frame').resetClock(); } catch (err) { /* */ }
                cachedMenu = { view: null, mgr: null };
                pendingRestart = null;
                settleFrames = 4;
                if (request.onDone !== null) request.onDone(true);
                return;
            }
            if (wasComplete) {
                console.log(`[aerox-tas] level: playCurrent ${request.level} (victory)`);
                try {
                    playCurrent();
                } catch (err) {
                    console.log(`[aerox-tas] playCurrent ${request.level} failed: ${err.message}`);
                    pendingRestart = null;
                    if (request.onDone !== null) request.onDone(false);
                    return;
                }
                try { require('./scene').invalidateDynamics(); } catch (err) { /* */ }
                try { require('../tas/rewind').reset('playCurrent'); } catch (err) { /* */ }
                try { require('../tas/warplog').resetLoad('playCurrent'); } catch (err) { /* */ }
                try { require('./frame').resetClock(); } catch (err) { /* */ }
                cachedMenu = { view: null, mgr: null };
                pendingRestart = null;
                settleFrames = 4;
                if (request.onDone !== null) request.onDone(true);
                return;
            }

            console.log(`[aerox-tas] level: loadLevel ${request.level} begin`);
            try {
                new ObjC.Object(view).loadLevel_(request.level);
                console.log(`[aerox-tas] level: loadLevel ${request.level} returned`);
            } catch (err) {
                console.log(`[aerox-tas] level restart failed: ${err.message}`);
                pendingRestart = null;
                if (request.onDone !== null) request.onDone(false);
                return;
            }
            try { require('./scene').invalidateDynamics(); } catch (err) { /* */ }
            try { require('../tas/rewind').reset('loadLevel'); } catch (err) { /* */ }
            try { require('../tas/warplog').resetLoad('loadLevel'); } catch (err) { /* */ }
            try { require('./frame').resetClock(); } catch (err) { /* */ }
            try { mem.global('cameraYaw').writeFloat(0); } catch (err) { /* */ }
            cachedMenu = { view: null, mgr: null };
            dismissPauseMenu();
            pendingRestart = null;
            settleFrames = 4;
            if (request.onDone !== null) request.onDone(true);
        });
    }, 0);
}

function afterRenderKick() {
    if (pendingRestart === null || pendingRestart.running) return;
    pendingRestart.view = frame.state.view;
    applyRestart();
}

function afterFrameSettle() {
    if (pendingRestart !== null) return;
    if (settleFrames > 0) settleFrames -= 1;
}

function install() {
    afterRenderKick._tasName = 'level.restartKick';
    afterFrameSettle._tasName = 'level.restart';
    frame.onAfterRender(afterRenderKick);
    frame.onAfterFrame(afterFrameSettle, 'level');
}

module.exports = {
    noteScene, loadedLevel,
    install, phase,
    inLevel, introPlaying, messageUp, readyPrompt, inPlay, started, complete, inMainMenu,
    playable,
    levelNumber, runTimer,
    skipIntro, dismissMessage, dismissPauseMenu, restart, restartPending, settling,
    setLevelNumber, menuAction, playCurrent, startGame, goMainMenu, setCurrentMenu, currentMenu,
    pausedInGame,
};
