// Why isn't the AeroMod tweak loading? Run with Aerox open:
//     frida -U -n Aerox -q -l tools/tweak_diag.js
// Prints what the tweak loader sees, then tries loading the gadget by hand
// (which starts AeroMod if it works). Paste the output into an issue.
// Only for when the pill does NOT appear: with the gadget running, this
// PC session is a second Frida in the same process and can crash Aerox.

const DIR = '/var/jb/Library/MobileSubstrate/DynamicLibraries';
const fm = ObjC.classes.NSFileManager.defaultManager();

function show(label, fn) {
    try { console.log(`${label}: ${fn()}`); } catch (e) { console.log(`${label}: ERROR ${e.message}`); }
}

show('bundle id', () => ObjC.classes.NSBundle.mainBundle().bundleIdentifier());
show('DynamicLibraries is a link to', () => fm.destinationOfSymbolicLinkAtPath_error_(DIR, NULL) || '(not a symlink)');
show('DynamicLibraries', () => fm.contentsOfDirectoryAtPath_error_(DIR, NULL));
show('TweakInject', () => fm.contentsOfDirectoryAtPath_error_('/var/jb/usr/lib/TweakInject', NULL));
show('AeroMod.plist', () => ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(DIR + '/AeroMod.plist', 4, NULL));
show('AeroMod.config', () => ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(DIR + '/AeroMod.config', 4, NULL));
show('script readable', () => fm.isReadableFileAtPath_('/var/jb/Library/AeroMod/aerox-tas.js'));
show('loader modules in Aerox', () => Process.enumerateModules()
    .map(m => m.name)
    .filter(n => /ellekit|inject|substrate|substitute|systemhook|libhooker|tweak|aeromod|gadget/i.test(n))
    .join(', ') || '(none - no tweaks are being injected into Aerox)');
if (Process.findModuleByName('AeroMod.dylib') !== null) {
    // The tweak loaded. A second Frida (this session) in the same process
    // fights the gadget, so stop here instead of poking it.
    console.log('AeroMod.dylib is loaded by the tweak - it works. Detach and do not attach from a PC while it is installed.');
} else show('manual load of AeroMod.dylib', () => {
    const m = Module.load(DIR + '/AeroMod.dylib');
    return `ok at ${m.base} - the gadget itself works; the loader just is not loading it`;
});
