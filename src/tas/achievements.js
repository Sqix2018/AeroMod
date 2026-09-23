// TAS-only unlocks. Nothing here writes LevelTime, iCloud, or Game Center.
// Requirements stay hidden until the unlock fires.
//
// Death-warp credit is a one-shot on the complete edge: is the ball away from
// EndFlare, and is this level new? No per-frame warp scan.

const storage = require('../core/storage');
const log = require('../core/log');
const frame = require('../game/frame');

const FILE = 'achievements.json';
const PORTAL_AWAY = 12;

const DEFS = [
    {
        id: 'warp1', skin: 'globe', ball: 'Globe',
        title: 'Around the world',
        desc: 'Complete a level with a death warp.',
    },
    {
        id: 'warp3', skin: 'eyeball', ball: 'Eyeball',
        title: 'Third eye',
        desc: 'Death-warp three different levels.',
    },
    {
        id: 'warp5', skin: 'flag', ball: 'Flags',
        title: 'Warp nomad',
        desc: 'Death-warp five different levels.',
    },
    {
        id: 'macro1', skin: 'golf', ball: 'Golf',
        title: 'Hole in one',
        desc: 'Complete an entire level with a macro.',
    },
    {
        id: 'invert', skin: 'mirror', ball: 'Mirror',
        title: 'Reflection',
        desc: 'Complete a level with Invert steer and Invert thrust on, using the virtual pad or keyboard (device tilt does not count).',
    },
    {
        id: 'goldsplits', skin: 'gold', ball: 'Golden',
        title: 'Aurum',
        desc: 'Place at least two splits, set a TAS gold, then beat every split on a later run.',
    },
    {
        id: 'level1fast', skin: 'glass', ball: 'Glass',
        title: 'Record shattered',
        desc: 'Complete level 1 in under 3.00s (real TAS finish, not a warp).',
    },
    {
        id: 'teleport250', skin: 'comet', ball: 'Comet',
        title: 'Shooting star',
        desc: 'Travel at least 250 units in a single TAS teleport.',
    },
    {
        id: 'warp1s5', skin: 'galaxy', ball: 'Galaxy',
        title: 'Wormhole',
        desc: 'Complete a death warp within 1.50s of the level starting.',
    },
    {
        id: 'clock20', skin: 'clock', ball: 'Clock',
        title: 'Tick by tick',
        desc: 'Use the +1 frame step button at least 20 times in a row.',
    },
    {
        id: 'smoothcam', skin: 'neon', ball: 'Neon',
        title: 'Smooth moves',
        desc: 'Successfully playback a recorded macro using PLAY CLEAN with SMOOTH CAM enabled.',
    },
];

const state = {
    unlocked: {},
    warpLevels: {},
    flag: 'us',
    loaded: false,
    installed: false,
};

const watch = {
    lastComplete: false,
    lastStarted: false,
    invertAtStart: false,
    virtualAtStart: false,
    usedTilt: false,
    stepStreak: 0,
};

function load() {
    if (state.loaded) return;
    const data = storage.readJson(FILE);
    if (data && typeof data === 'object') {
        state.unlocked = data.unlocked && typeof data.unlocked === 'object' ? data.unlocked : {};
        state.warpLevels = data.warpLevels && typeof data.warpLevels === 'object' ? data.warpLevels : {};
        if (typeof data.flag === 'string') state.flag = data.flag;
    }
    state.loaded = true;
}

function persist() {
    load();
    storage.writeJson(FILE, {
        version: 2,
        unlocked: state.unlocked,
        warpLevels: state.warpLevels,
        flag: state.flag,
    });
}

function defById(id) {
    for (let i = 0; i < DEFS.length; i++) {
        if (DEFS[i].id === id) return DEFS[i];
    }
    return null;
}

function isUnlocked(id) {
    load();
    return !!state.unlocked[id];
}

function skinUnlocked(skin) {
    load();
    for (let i = 0; i < DEFS.length; i++) {
        if (DEFS[i].skin === skin) return !!state.unlocked[DEFS[i].id];
    }
    return false;
}

function unlock(id) {
    load();
    if (state.unlocked[id]) return false;
    const def = defById(id);
    if (def === null) return false;
    state.unlocked[id] = { at: Date.now() };
    persist();
    log.info(`unlocked ${def.title}  (${def.ball})  -  ${def.desc}`, 'skin');
    try { require('../ui/unlock').flash(def); } catch (err) { /* */ }
    return true;
}

function checkWarpCount() {
    const n = Object.keys(state.warpLevels).length;
    if (n >= 1) unlock('warp1');
    if (n >= 3) unlock('warp3');
    if (n >= 5) unlock('warp5');
}

function noteWarp(level, time) {
    load();
    if (level === null || level < 0) return;
    const key = String(level);
    if (!state.warpLevels[key]) {
        state.warpLevels[key] = true;
        persist();
        checkWarpCount();
    }
    if (typeof time === 'number' && time >= 0 && time <= 1.5) {
        unlock('warp1s5');
    }
}

function noteFinish(info) {
    load();
    if (!info || info.warp) return;
    if (info.level === 1 && info.time < 3) unlock('level1fast');
    if (info.beatAllGold) unlock('goldsplits');
}

function noteTeleport(distance) {
    load();
    if (distance >= 250) unlock('teleport250');
}

function setFlag(code) {
    load();
    state.flag = code;
    persist();
    return state.flag;
}

function resetAll() {
    load();
    state.unlocked = {};
    state.warpLevels = {};
    persist();
    watch.lastComplete = false;
    watch.lastStarted = false;
    watch.invertAtStart = false;
    watch.virtualAtStart = false;
    watch.usedTilt = false;
    watch.stepStreak = 0;
    log.info('achievements reset', 'skin');
    return true;
}

function invertBoth() {
    try {
        const input = require('../game/input').state;
        return !!input.invertSteer && !!input.invertThrust;
    } catch (err) {
        return false;
    }
}

function virtualNow() {
    try {
        const input = require('../game/input').state;
        if (input.enabled) return true;
        if (input.override !== null) return true;
    } catch (err) { /* */ }
    try {
        if (require('../ui/keyboard').state.enabled) return true;
    } catch (err) { /* */ }
    return false;
}

function markDeviceTilt() {
    watch.usedTilt = true;
}

function noteFrameStep(n) {
    const count = n === undefined ? 1 : (n | 0);
    if (count === 1) {
        watch.stepStreak += 1;
        if (watch.stepStreak >= 20) unlock('clock20');
    } else {
        watch.stepStreak = 0;
    }
}

function finishAwayFromPortal() {
    try {
        const pos = require('../game/ball').position();
        if (pos === null) return false;
        const flare = require('./deathwarp').finish();
        if (flare === null || flare.position === null) return false;
        const dx = pos.x - flare.position.x;
        const dz = pos.z - flare.position.z;
        return (dx * dx + dz * dz) > (PORTAL_AWAY * PORTAL_AWAY);
    } catch (err) {
        return false;
    }
}

function fireComplete() {
    const level = require('../game/level');
    const n = level.levelNumber();
    const time = level.runTimer();
    let auto = false;
    try { auto = require('./deathwarp').autoOn(); } catch (err) { /* */ }
    const away = !auto && finishAwayFromPortal();
    if (away) noteWarp(n, time);

    try {
        const m = require('./macro').state;
        if (m.playFromStart && (m.mode === 'playing' || m.mode === 'lingering')) {
            unlock('macro1');
            if (m.playClean && m.playSmoothCam) unlock('smoothcam');
        }
    } catch (err) { /* */ }

    if (watch.invertAtStart && watch.virtualAtStart && !watch.usedTilt
        && invertBoth() && virtualNow()) {
        unlock('invert');
    }

    if (!away && n === 1 && time < 3) unlock('level1fast');
}

function onFrame() {
    const level = require('../game/level');
    let complete = false;
    let started = false;
    try {
        if (level.inMainMenu()) {
            watch.lastComplete = false;
            watch.lastStarted = false;
            return;
        }
        complete = level.complete();
        started = level.started();
    } catch (err) {
        return;
    }
    if (started && !watch.lastStarted && !complete) {
        watch.invertAtStart = invertBoth();
        watch.virtualAtStart = virtualNow();
        watch.usedTilt = false;
    }
    if (complete && !watch.lastComplete) {
        try { fireComplete(); } catch (err) {
            log.info(`achieve complete: ${err.message}`, 'skin');
        }
    }
    watch.lastComplete = complete;
    watch.lastStarted = started;
}

function list() {
    load();
    return DEFS.map(d => {
        const open = !!state.unlocked[d.id];
        return {
            id: d.id,
            skin: d.skin,
            ball: d.ball,
            title: d.ball,
            achieveTitle: d.title,
            detail: open ? d.desc : 'Hidden until unlocked.',
            unlocked: open,
        };
    });
}

function install() {
    load();
    checkWarpCount();
    if (state.installed) return true;
    frame.onAfterFrame(log.guard('achieve.onFrame', onFrame), 'level');
    state.installed = true;
    return true;
}

module.exports = {
    DEFS, state, install, list, isUnlocked, skinUnlocked,
    noteWarp, noteFinish, noteTeleport, setFlag, unlock, resetAll, markDeviceTilt,
    noteFrameStep,
};
