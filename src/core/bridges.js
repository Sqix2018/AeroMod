// Frida 17 no longer builds the ObjC bridge into the runtime. The frida CLI
// adds one to scripts it loads; Frida Gadget running this file from disk (the
// Sileo package, sideloaded IPAs) does not, so bring our own copy.
// Required first by index.js, before any module touches ObjC.

let present = false;
try { present = typeof ObjC !== 'undefined' && ObjC !== null; } catch (err) { present = false; }
if (!present) globalThis.ObjC = require('../vendor/objc-bridge');

module.exports = { vendored: !present };
