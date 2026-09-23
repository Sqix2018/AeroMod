// What AeroMod is holding, and how close iOS is to jetsam.
//
// Process terminated with no CRASH is usually the OS killing Aerox for
// memory, not a hooked exception. os_proc_available_memory is the bytes
// left before that kill. Rewind snaps, the warp scene walk, and a custom
// ball texture are the pieces this tool can actually turn off.

const log = require('./log');
const storage = require('./storage');
const mem = require('./mem');

const FILE = 'memory.json';
const PRESSURE_MB = 48;

const state = {
    rewind: true,
    warp: true,
    skins: true,
    loaded: false,
    lastFree: null,
    warned: false,
};

let availableFn = null;
let availableTried = false;

function load() {
    if (state.loaded) return;
    state.loaded = true;
    const data = storage.readJson(FILE);
    if (!data || typeof data !== 'object') return;
    if (typeof data.rewind === 'boolean') state.rewind = data.rewind;
    if (typeof data.warp === 'boolean') state.warp = data.warp;
    if (typeof data.skins === 'boolean') state.skins = data.skins;
}

function save() {
    load();
    storage.writeJson(FILE, {
        rewind: state.rewind,
        warp: state.warp,
        skins: state.skins,
    });
}

function asBytes(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    try {
        if (typeof raw.toNumber === 'function') {
            const n = raw.toNumber();
            if (isFinite(n)) return n;
        }
    } catch (err) { /* */ }
    const s = String(raw);
    const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    return isFinite(n) ? n : null;
}

function plausible(n) {
    return isFinite(n) && n >= 8 * 1024 * 1024 && n <= 3 * 1024 * 1024 * 1024;
}

function availableBytes() {
    if (!availableTried) {
        availableTried = true;
        try {
            const p = mem.findExport(null, 'os_proc_available_memory');
            if (p !== null) availableFn = new NativeFunction(p, 'uint64', []);
            else log.debug('mem probe missing os_proc_available_memory', 'mem');
        } catch (err) {
            availableFn = null;
            log.debug(`mem probe available bind ${err.message}`, 'mem');
        }
    }
    if (availableFn === null) return null;
    try {
        const n = asBytes(availableFn());
        if (!availableBytes.logged) {
            availableBytes.logged = true;
            log.debug(`mem probe free raw ${n === null ? 'bad' : Math.round(n / (1024 * 1024)) + 'MB'}`, 'mem');
        }
        return (isFinite(n) && n >= 0 && n <= 8 * 1024 * 1024 * 1024) ? n : null;
    } catch (err) {
        if (!availableBytes.logged) {
            availableBytes.logged = true;
            log.debug(`mem probe free threw ${err.message}`, 'mem');
        }
        return null;
    }
}

function taskPort() {
    const slot = mem.findExport(null, 'mach_task_self_');
    if (slot !== null) {
        const port = slot.readU32();
        if (port) return { port, via: 'mach_task_self_' };
    }
    const trap = mem.findExport(null, 'task_self_trap');
    if (trap !== null) {
        const port = new NativeFunction(trap, 'uint', [])() >>> 0;
        if (port) return { port, via: 'task_self_trap' };
    }
    return { port: 0, via: 'none' };
}

function pidResident() {
    const p = mem.findExport(null, 'proc_pidinfo');
    if (p === null) return null;
    if (!pidResident.fn) {
        pidResident.fn = new NativeFunction(p, 'int', ['int', 'int', 'uint64', 'pointer', 'int']);
        pidResident.buf = Memory.alloc(256);
    }
    const n = pidResident.fn(Process.id, 4, 0, pidResident.buf, 96);
    if (n < 16) return null;
    return asBytes(pidResident.buf.add(8).readU64());
}

function footprintBytes() {
    try {
        if (footprintBytes.fn === undefined) {
            const info = mem.findExport(null, 'task_info');
            footprintBytes.fn = info === null
                ? null
                : new NativeFunction(info, 'int', ['uint', 'int', 'pointer', 'pointer']);
            if (footprintBytes.fn === null) log.debug('mem probe missing task_info', 'mem');
        }
        if (!footprintBytes.buf) {
            footprintBytes.buf = Memory.alloc(512);
            footprintBytes.count = Memory.alloc(4);
        }
        const info = footprintBytes.buf;
        const count = footprintBytes.count;
        const task = taskPort();
        let krBasic = -1;
        let resident = null;
        let krVm = -1;
        let best = null;
        if (footprintBytes.fn !== null && task.port) {
            count.writeU32(16);
            krBasic = footprintBytes.fn(task.port, 20, info, count);
            if (krBasic === 0) resident = asBytes(info.add(8).readU64());
            count.writeU32(128);
            krVm = footprintBytes.fn(task.port, 22, info, count);
            if (krVm === 0) {
                [16, 48, 144, 152, 160].forEach(off => {
                    const n = asBytes(info.add(off).readU64());
                    if (plausible(n) && (best === null || n > best)) best = n;
                });
            }
        }
        if (!plausible(best) && plausible(resident)) best = resident;
        let pidRss = null;
        if (!plausible(best)) {
            pidRss = pidResident();
            if (plausible(pidRss)) best = pidRss;
        }
        if (!footprintBytes.logged) {
            footprintBytes.logged = true;
            const mb = (n) => (n === null || !isFinite(n)) ? '?' : `${Math.round(n / (1024 * 1024))}MB`;
            log.debug(`mem probe task via=${task.via} port=${task.port}`
                + ` basic=${krBasic} resident=${mb(resident)} vm=${krVm}`
                + ` pid=${mb(pidRss)} pick=${mb(best)}`, 'mem');
        }
        return plausible(best) ? best : null;
    } catch (err) {
        if (!footprintBytes.logged) {
            footprintBytes.logged = true;
            log.debug(`mem probe task threw ${err.message}`, 'mem');
        }
        return null;
    }
}

function rewindOn() { load(); return state.rewind; }
function warpOn() { load(); return state.warp; }
function skinsOn() { load(); return state.skins; }

function setRewind(on) {
    load();
    state.rewind = !!on;
    save();
    if (!state.rewind) {
        try { require('../tas/rewind').reset('rewind off'); } catch (err) { /* */ }
    }
    log.info(`rewind snaps ${state.rewind ? 'on' : 'OFF'}`, 'mem');
    return state.rewind;
}

function setWarp(on) {
    load();
    state.warp = !!on;
    save();
    if (!state.warp) {
        try { require('../tas/warplog').releaseIdleBuffers('warp off'); } catch (err) { /* */ }
        try { require('../ui/minimap').setVisible(false); } catch (err) { /* */ }
        try { require('../tas/deathwarp').setAutoVoid(false); } catch (err) { /* */ }
    }
    log.info(`warp watch ${state.warp ? 'on' : 'OFF'}`, 'mem');
    return state.warp;
}

function setSkins(on) {
    load();
    state.skins = !!on;
    save();
    if (!state.skins) {
        try {
            const skins = require('../tas/skins');
            if (skins.state.applied || skins.state.pending) skins.restore();
        } catch (err) { /* */ }
    }
    log.info(`skin apply ${state.skins ? 'on' : 'OFF'}`, 'mem');
    return state.skins;
}

function snapshot() {
    load();
    const free = availableBytes();
    const rss = footprintBytes();
    const freeMB = free === null ? null : Math.round(free / (1024 * 1024));
    const rssMB = rss === null ? null : Math.round(rss / (1024 * 1024));
    let rewindFrames = 0;
    let rewindKb = 0;
    let hits = 0;
    let movers = 0;
    let watch = false;
    let macroFrames = 0;
    let skin = 'off';
    try {
        const rw = require('../tas/rewind').state;
        rewindFrames = rw.history.length;
        const last = rewindFrames ? rw.history[rewindFrames - 1] : null;
        const bodies = last && last.bodies ? last.bodies.length : 0;
        rewindKb = Math.round((rewindFrames * Math.max(bodies, 1) * 180) / 1024);
    } catch (err) { /* */ }
    try {
        const w = require('../tas/warplog');
        hits = w.state.hits.length;
        movers = w.state.movers.length;
        watch = w.wantWatch();
    } catch (err) { /* */ }
    try {
        macroFrames = require('../tas/macro').state.frames.length;
    } catch (err) { /* */ }
    try {
        const s = require('../tas/skins').state;
        if (!state.skins) skin = 'OFF';
        else if (s.pending) skin = 'apply';
        else if (s.applied) skin = s.applied;
        else skin = 'stock';
    } catch (err) { /* */ }
    return {
        freeMB, rssMB, rewindFrames, rewindKb, hits, movers, watch, macroFrames, skin,
    };
}

function suffix() {
    const s = snapshot();
    const free = s.freeMB === null ? '?' : `${s.freeMB}MB`;
    const rss = s.rssMB === null ? '?' : `${s.rssMB}MB`;
    const rw = state.rewind ? `${s.rewindFrames}f/${s.rewindKb}KB` : 'OFF';
    const warp = state.warp ? (s.watch ? `on/${s.movers}mov` : 'idle') : 'OFF';
    const text = `mem free=${free} rss=${rss} rewind=${rw} warp=${warp}`
        + ` hits=${s.hits} macro=${s.macroFrames}f skin=${s.skin}`;
    if (s.freeMB !== null && s.freeMB < PRESSURE_MB) {
        if (!state.warned) {
            state.warned = true;
            log.warn(`${text}  low - dropping idle buffers`, 'mem');
            releaseIdle('pressure');
        }
    } else if (s.freeMB !== null && s.freeMB > PRESSURE_MB + 32) {
        state.warned = false;
    }
    const prev = state.lastFree;
    state.lastFree = s.freeMB;
    if (prev !== null && s.freeMB !== null && prev - s.freeMB >= 24) {
        log.debug(`${text}  dropped ${prev - s.freeMB}MB`, 'mem');
    }
    return text;
}

function releaseIdle(why) {
    let note = why || 'release';
    try {
        const rw = require('../tas/rewind');
        const mode = require('../tas/macro').state.mode;
        const paused = require('../game/frame').state.paused;
        const keep = state.rewind && (paused || mode === 'recording');
        if (!keep && rw.state.history.length) {
            note += ` rewind ${rw.state.history.length}`;
            rw.reset(why || 'idle');
        }
    } catch (err) { /* */ }
    try {
        const w = require('../tas/warplog');
        if (!w.wantWatch()) w.releaseIdleBuffers(why || 'idle');
    } catch (err) { /* */ }
    try { require('../game/scene').invalidateDynamics(); } catch (err) { /* */ }
    log.info(`released idle buffers (${note})`, 'mem');
    return suffix();
}

function rssMB() {
    const n = footprintBytes();
    return n === null ? null : n / (1024 * 1024);
}

module.exports = {
    rssMB,
    state, rewindOn, warpOn, skinsOn,
    setRewind, setWarp, setSkins,
    snapshot, suffix, releaseIdle,
};
