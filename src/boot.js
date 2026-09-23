// First thing the bundle runs.
//
// From a PC, Frida attaches to an Aerox that is already on screen. From the
// Sileo package, Frida Gadget runs this file while the app is still being
// loaded - before UIApplicationMain, before there is a window - and there is
// no console to see errors in. So:
//   - boot.log (Documents/aerox-tas/boot.log) is written with plain libc
//     calls, which work before the ObjC bridge and before log.js;
//   - AeroMod starts once UIApplication exists, and any error on the way is
//     written there with its stack.

let fileLog = null;

function bootLog(message) {
    const line = `${new Date().toISOString()}  ${message}`;
    try { console.log(`[aerox-tas] boot: ${message}`); } catch (err) { /* */ }
    try {
        if (fileLog === null) {
            const find = (name) => Module.getGlobalExportByName(name);
            const getenv = new NativeFunction(find('getenv'), 'pointer', ['pointer']);
            const mkdir = new NativeFunction(find('mkdir'), 'int', ['pointer', 'int']);
            const fopen = new NativeFunction(find('fopen'), 'pointer', ['pointer', 'pointer']);
            const fputs = new NativeFunction(find('fputs'), 'int', ['pointer', 'pointer']);
            const fclose = new NativeFunction(find('fclose'), 'int', ['pointer']);
            const home = getenv(Memory.allocUtf8String('HOME'));
            if (home.isNull()) return;
            const dir = `${home.readUtf8String()}/Documents/aerox-tas`;
            mkdir(Memory.allocUtf8String(dir), 0o755);
            const path = Memory.allocUtf8String(`${dir}/boot.log`);
            const mode = Memory.allocUtf8String('a');
            fileLog = (text) => {
                const f = fopen(path, mode);
                if (f.isNull()) return;
                fputs(Memory.allocUtf8String(`${text}\n`), f);
                fclose(f);
            };
        }
        fileLog(line);
    } catch (err) { /* nowhere left to report */ }
}

function fail(stage, err) {
    bootLog(`${stage} FAILED: ${err && err.message ? err.message : err}`);
    if (err && err.stack) bootLog(String(err.stack));
}

let hadObjC = false;
try { hadObjC = typeof ObjC !== 'undefined' && ObjC !== null; } catch (err) { hadObjC = false; }
bootLog(`start (${hadObjC ? 'ObjC from Frida' : 'vendored ObjC bridge'}, Frida ${Frida.version})`);

try {
    require('./core/bridges');
} catch (err) {
    fail('ObjC bridge', err);
}

function appReady() {
    try {
        if (!ObjC.available) return false;
        const app = ObjC.classes.UIApplication;
        return app !== undefined && app.sharedApplication() !== null;
    } catch (err) {
        return false;
    }
}

function launch() {
    bootLog('app is up - starting AeroMod');
    try {
        require('./index');
        bootLog('AeroMod loaded');
    } catch (err) {
        fail('AeroMod start', err);
    }
}

if (appReady()) {
    launch();
} else {
    bootLog('waiting for the app to finish launching');
    let tries = 0;
    const timer = setInterval(function () {
        tries += 1;
        if (appReady()) {
            clearInterval(timer);
            launch();
        } else if (tries > 240) {
            clearInterval(timer);
            bootLog(`gave up: no UIApplication after 60s (ObjC.available=${(() => {
                try { return ObjC.available; } catch (err) { return 'error'; }
            })()})`);
        }
    }, 250);
}

module.exports = { bootLog };
