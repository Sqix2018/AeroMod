// One place for everything the tool wants to say.
//
// console.log goes to the Frida/conda terminal when you are attached.
// The LOG tab shows the same lines (last 80). A short rotating file in the
// app Documents folder survives a Frida disconnect / Anaconda cutoff / jetsam,
// which is how we still see the last perf line after Process terminated.

const LINES = 80;
const FILE_MAX = 180 * 1024;
const FILE_TMP = '/tmp/aerox-tas.log';
let fileDocuments = null;
let fileTape = null;
const pendingFile = [];
let lastFlush = 0;

function documentsFile() {
    if (fileDocuments !== null) return fileDocuments;
    try {
        const urls = ObjC.classes.NSFileManager.defaultManager()
            .URLsForDirectory_inDomains_(9, 1);
        if (urls !== null && urls.count() > 0) {
            const dir = `${urls.objectAtIndex_(0).path().toString()}/aerox-tas`;
            ObjC.classes.NSFileManager.defaultManager()
                .createDirectoryAtPath_withIntermediateDirectories_attributes_error_(
                    dir, true, NULL, NULL);
            fileDocuments = `${dir}/tas.log`;
            fileTape = `${dir}/tape.log`;
            return fileDocuments;
        }
    } catch (err) { /* */ }
    return null;
}

const state = {
    lines: [],
    counter: 0,
    toFile: true,
    file: null,
    failedFile: false,
};

function stamp() {
    const d = new Date();
    const pad = (n, w) => String(n).padStart(w === undefined ? 2 : w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `.${pad(d.getMilliseconds(), 3)}`;
}

function appendPath(path, line) {
    const f = new File(path, 'a');
    f.write(line + '\n');
    f.flush();
    f.close();
}

function wipePath(path) {
    try {
        const f = new File(path, 'w');
        f.write('');
        f.flush();
        f.close();
    } catch (err) { /* */ }
    try {
        ObjC.classes.NSFileManager.defaultManager().removeItemAtPath_error_(path, NULL);
    } catch (err) { /* */ }
}

function scrubOldFiles() {
    wipePath(FILE_TMP);
    try {
        const docs = documentsFile();
        if (docs !== null) wipePath(docs);
    } catch (err) { /* */ }
}

function fileSize(path) {
    try {
        const dict = ObjC.classes.NSFileManager.defaultManager()
            .attributesOfItemAtPath_error_(path, NULL);
        if (dict === null) return 0;
        const n = dict.objectForKey_('NSFileSize');
        if (n === null || n === undefined) return 0;
        return parseInt(n.toString(), 10) || 0;
    } catch (err) { return 0; }
}

function flushFile() {
    if (!state.toFile || pendingFile.length === 0) return;
    const block = pendingFile.join('\n') + '\n';
    pendingFile.length = 0;
    lastFlush = Date.now();
    const docs = documentsFile();
    if (docs === null) return;
    try {
        appendPath(docs, block.replace(/\n$/, ''));
    } catch (err) {
        if (!state.failedFile) {
            state.failedFile = true;
            state.lines.push(`${stamp()}  [log] documents sink off: ${err.message}`);
        }
    }
}

function sinkFile(line, flushNow) {
    if (!state.toFile) return;
    pendingFile.push(line);
    if (flushNow || pendingFile.length >= 12 || Date.now() - lastFlush > 400) {
        flushFile();
    }
}

function write(tag, message) {
    state.counter += 1;
    const line = `${stamp()}  ${tag ? `[${tag}] ` : ''}${message}`;

    state.lines.push(line);
    if (state.lines.length > LINES) state.lines.splice(0, state.lines.length - LINES);

    try { console.log(`[aerox-tas] ${tag ? `${tag}: ` : ''}${message}`); } catch (err) { /* no console */ }
    sinkFile(line, tag === 'CRASH' || tag === 'ERROR');
    return line;
}

// Diagnostics: tas.log on the device only. The Frida console is for things
// a player acts on; a crash still prints its own context there.
function debug(message, tag) {
    sinkFile(`${stamp()}  ${tag ? `[${tag}] ` : ''}${message}`, false);
}

// Perf / idle breadcrumbs: device file only (was also the console, every 2s).
function breadcrumb(message) {
    const text = String(message || '');
    sinkFile(`${stamp()}  ${text}`, true);
}

// One line per recorded / played frame. File only — console.log of every
// tick is what walked Frida into Process terminated on a long PLAY.
const pendingTape = [];
let lastTapeFlush = 0;

function flushTape() {
    if (pendingTape.length === 0) return;
    const block = pendingTape.join('\n');
    pendingTape.length = 0;
    lastTapeFlush = Date.now();
    try {
        if (fileTape === null) documentsFile();
        if (fileTape !== null) appendPath(fileTape, block);
    } catch (err) { /* */ }
}

let tapeMissShown = false;
const TAPE_MAX = 4 * 1024 * 1024;

function tape(message) {
    const text = String(message || '');
    if (text.indexOf('MISS') === 0 && !tapeMissShown) {
        tapeMissShown = true;
        try { console.log(`[aerox-tas] tape first ${text}`); } catch (err) { /* */ }
    }
    if (!state.toFile) return;
    pendingTape.push(`${stamp()}  ${text}`);
    if (pendingTape.length >= 20 || Date.now() - lastTapeFlush > 250) flushTape();
}

function resetTape() {
    try { flushTape(); } catch (err) { /* */ }
    try {
        if (fileTape === null) documentsFile();
        if (fileTape !== null) wipePath(fileTape);
    } catch (err) { /* */ }
    lastTapeFlush = 0;
}

// New RECORD / PLAY run in tape.log. Runs append so two PLAYs can be diffed;
// the file is wiped once it passes TAPE_MAX.
function beginTape(label) {
    try { flushTape(); } catch (err) { /* */ }
    tapeMissShown = false;
    try {
        if (fileTape === null) documentsFile();
        if (fileTape !== null && fileSize(fileTape) > TAPE_MAX) wipePath(fileTape);
    } catch (err) { /* */ }
    tape(`${label}  ${stamp()}`);
    if (fileTape !== null) {
        try { console.log(`[aerox-tas] tape: ${label} -> ${fileTape}`); } catch (err) { /* */ }
    }
}

const info = (message, tag) => write(tag || '', message);
const warn = (message, tag) => write(tag || 'warn', message);

// Errors carry the stack, because the UI's try/catch blocks used to swallow
// them and leave a button that silently did nothing.
function error(where, err) {
    const detail = err === undefined ? '' : `: ${err.message}`;
    write('ERROR', `${where}${detail}`);
    if (err !== undefined && err.stack !== undefined) {
        String(err.stack).split('\n').slice(0, 6)
            .forEach(l => write('ERROR', `    ${l.trim()}`));
    }
}

// Wraps a callback so a throw is reported instead of vanishing.
const crumb = { hook: 'boot', at: 0 };

function mark(where) {
    crumb.hook = String(where || 'unknown');
    crumb.at = Date.now();
}

function guard(where, fn) {
    const wrapped = function () {
        mark(where);
        try { return fn.apply(this, arguments); } catch (err) { error(where, err); }
    };
    wrapped._tasName = where;
    return wrapped;
}

function tail(count) {
    const n = count === undefined ? 40 : count;
    return state.lines.slice(Math.max(0, state.lines.length - n));
}

function text(count) { return tail(count).join('\n'); }

function clear() {
    state.lines = [];
    state.counter = 0;
}

// Native faults would otherwise take the process down with nothing written.
function prepareFile() {
    state.toFile = true;
    state.failedFile = false;
    try {
        const docs = documentsFile();
        if (docs === null) {
            state.toFile = false;
            return;
        }
        if (fileSize(docs) > FILE_MAX) wipePath(docs);
        sinkFile(`${stamp()}  --- session start ---`, true);
    } catch (err) {
        state.toFile = false;
    }
}

function installCrashHandler() {
    try {
        Process.setExceptionHandler(function (details) {
            write('CRASH', `${details.type} at ${details.address}`);
            write('CRASH', `  lastHook=${crumb.hook} age=${Date.now() - (crumb.at || 0)}ms`);
            if (details.memory !== undefined && details.memory !== null) {
                write('CRASH', `  ${details.memory.operation} ${details.memory.address}`);
            }
            try {
                const bt = Thread.backtrace(details.context, Backtracer.ACCURATE)
                    .slice(0, 12);
                bt.forEach(addr => {
                    let line = String(addr);
                    try { line = String(DebugSymbol.fromAddress(addr)); } catch (err) { /* */ }
                    try {
                        const mem = require('./mem');
                        if (addr.compare(mem.base) >= 0) {
                            line += `  Aerox+${addr.sub(mem.base)}`;
                        }
                    } catch (err) { /* */ }
                    write('CRASH', `  ${line}`);
                });
            } catch (err) { write('CRASH', '  (no backtrace)'); }
            try {
                const level = require('../game/level');
                write('CRASH', `  phase=${level.phase()} in=${level.inLevel() ? 1 : 0}`
                    + ` started=${level.started() ? 1 : 0}`
                    + ` intro=${level.introPlaying() ? 1 : 0}`
                    + ` restart=${level.restartPending() ? 1 : 0}`);
            } catch (err) { /* */ }
            try {
                const macro = require('../tas/macro');
                write('CRASH', `  macro ${macro.state.mode} ${macro.state.frames.length}f`
                    + ` cursor=${macro.state.cursor}`);
            } catch (err) { /* */ }
            try {
                const rewind = require('../tas/rewind');
                write('CRASH', `  rewind hist=${rewind.state.history.length}`
                    + ` last=${rewind.state.lastOp}`);
            } catch (err) { /* */ }
            try {
                const macro = require('../tas/macro');
                if (macro.persist('crash', true)) {
                    write('CRASH', `  auto-saved ${macro.state.autoSaveName || macro.state.loaded}`
                        + ` ${macro.state.frames.length}f`);
                }
            } catch (err) { /* */ }
            try { flushFile(); } catch (err) { /* */ }
            try { flushTape(); } catch (err) { /* */ }
            return false; // let the app handle it as it normally would
        });
        prepareFile();
        const docs = documentsFile();
        info('crash handler armed. Crashes print here in the Frida console.'
            + (docs ? `  file ${docs}` : ''));
    } catch (err) {
        warn(`could not arm crash handler: ${err.message}`);
    }
}

module.exports = {
    state, FILE: FILE_TMP, FILE_TMP, documentsFile,
    info, warn, error, debug, guard, mark, crumb, tail, text, clear, write,
    breadcrumb, tape, beginTape, resetTape, flushTape, flushFile, prepareFile,
    installCrashHandler, scrubOldFiles,
};
