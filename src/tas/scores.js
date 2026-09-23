// Keep TAS completions off the level-select bests and off Game Center.
//
// The game writes a new best from two places, both while the finish is up:
// processGameFrame compares runTimer to NSUserDefaults "LevelTime%d" and
// setFloats if it is lower, then GCHelper reportScore:forCategory: uploads it.
// updateLevelMenuRanking:: can write the same key when the menu redraws.
// iCloud then copies whatever is in defaults. Blocking those writes while the
// TAS is enabled leaves the on-screen run timer alone - you still see the
// time, it just never becomes the saved best. Closing the TAS puts the original
// IMPs back, so a later legitimate run saves exactly as it would without us.

const log = require('../core/log');

const state = { installed: false, blocked: 0 };

const hooks = [];

function isLevelTimeKey(keyPtr) {
    if (keyPtr === undefined || keyPtr === null || keyPtr.isNull()) return false;
    try {
        return new ObjC.Object(keyPtr).toString().indexOf('LevelTime') === 0;
    } catch (err) {
        return false;
    }
}

function noteBlock(where) {
    state.blocked += 1;
    const n = state.blocked;
    if (n > 4 && n % 20 !== 0) return;
    // The finish path calls this from a NativeCallback. Logging there has
    // crashed the process on the victory tick, so defer it.
    setTimeout(function () {
        try {
            log.info(`blocked ${where} (AeroMod is on; close AeroMod to save real bests)`, 'time');
        } catch (err) { /* */ }
    }, 0);
}

function swap(clsName, sel, retType, argTypes, replacement) {
    const cls = ObjC.classes[clsName];
    if (cls === undefined) return false;
    const method = cls[sel];
    if (method === undefined) return false;
    const original = method.implementation;
    const origFn = new NativeFunction(original, retType, argTypes);
    const cb = new NativeCallback(replacement(origFn), retType, argTypes);
    method.implementation = cb;
    hooks.push({ method, original, cb });
    return true;
}

function install() {
    if (state.installed) return true;
    if (!ObjC.available) return false;
    hooks.length = 0;

    swap('NSUserDefaults', '- setFloat:forKey:', 'void',
        ['pointer', 'pointer', 'float', 'pointer'],
        function (orig) {
            return function (self, sel, value, key) {
                if (isLevelTimeKey(key)) {
                    noteBlock('LevelTime defaults write');
                    return;
                }
                orig(self, sel, value, key);
            };
        });

    swap('NSUbiquitousKeyValueStore', '- setObject:forKey:', 'void',
        ['pointer', 'pointer', 'pointer', 'pointer'],
        function (orig) {
            return function (self, sel, obj, key) {
                if (isLevelTimeKey(key)) {
                    noteBlock('LevelTime iCloud write');
                    return;
                }
                orig(self, sel, obj, key);
            };
        });

    swap('GCHelper', '- reportScore:forCategory:', 'void',
        ['pointer', 'pointer', 'int64', 'pointer'],
        function () {
            return function () {
                noteBlock('Game Center score');
            };
        });

    swap('GKScore', '- reportScoreWithCompletionHandler:', 'void',
        ['pointer', 'pointer', 'pointer'],
        function () {
            return function () {
                noteBlock('GKScore upload');
            };
        });

    state.installed = hooks.length > 0;
    if (state.installed) {
        log.info('best-time and Game Center writes gated while AeroMod is on', 'time');
    } else {
        log.warn('could not hook score saves; TAS times may still write a best', 'time');
    }
    return state.installed;
}

function uninstall() {
    if (!state.installed) return;
    hooks.forEach(h => {
        try { h.method.implementation = h.original; } catch (err) { /* */ }
    });
    hooks.length = 0;
    state.installed = false;
}

module.exports = { state, install, uninstall };
