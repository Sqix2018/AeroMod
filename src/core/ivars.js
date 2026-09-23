// Ask the ObjC runtime for ivar offsets instead of trusting the static dump.
// Falls back to the dumped values if the runtime lookup fails.

const offsets = require('./offsets');

function globalExport(name) {
    if (typeof Module.getGlobalExportByName === 'function') {
        return Module.getGlobalExportByName(name);
    }
    return Module.getExportByName(null, name);
}

let objc_getClass = null;
let class_getInstanceVariable = null;
let ivar_getOffset = null;

try {
    objc_getClass = new NativeFunction(globalExport('objc_getClass'), 'pointer', ['pointer']);
    class_getInstanceVariable = new NativeFunction(
        globalExport('class_getInstanceVariable'), 'pointer', ['pointer', 'pointer']);
    ivar_getOffset = new NativeFunction(globalExport('ivar_getOffset'), 'long', ['pointer']);
} catch (err) {
    console.log(`[aerox-tas] libobjc lookup failed (${err.message}); using dumped ivar offsets`);
}

const fallbacks = offsets.resolve().layout.ivars;

// className -> { ivarName: offset }
const cache = {};

function classIvars(className) {
    if (cache[className] !== undefined) return cache[className];

    const out = Object.assign({}, fallbacks[className] || {});

    if (objc_getClass !== null) {
        try {
            const cls = objc_getClass(Memory.allocUtf8String(className));
            if (!cls.isNull()) {
                for (const name of Object.keys(out)) {
                    const ivar = class_getInstanceVariable(cls, Memory.allocUtf8String(name));
                    if (!ivar.isNull()) out[name] = ivar_getOffset(ivar).valueOf();
                }
            }
        } catch (err) {
            console.log(`[aerox-tas] ivar lookup failed for ${className}: ${err.message}`);
        }
    }

    cache[className] = out;
    return out;
}

function offsetOf(className, ivarName) {
    const map = classIvars(className);
    if (map[ivarName] !== undefined) return map[ivarName];
    if (objc_getClass !== null) {
        try {
            const cls = objc_getClass(Memory.allocUtf8String(className));
            if (!cls.isNull()) {
                const ivar = class_getInstanceVariable(cls, Memory.allocUtf8String(ivarName));
                if (!ivar.isNull()) {
                    map[ivarName] = ivar_getOffset(ivar).valueOf();
                    return map[ivarName];
                }
            }
        } catch (err) { /* */ }
    }
    throw new Error(`unknown ivar ${className}.${ivarName}`);
}

module.exports = { classIvars, offsetOf };
