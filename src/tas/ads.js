// Interstitial suppression.
//
// -[EAGLView shouldDisplayInterstitial:] is the app's own gate in front of the
// Chartboost delegate: the SDK asks before presenting, and the app answers based
// on whether a level is loaded. Returning NO from it is the least invasive place
// to stop an ad landing in the middle of a run - the SDK keeps caching and
// reporting exactly as it would, it simply never gets permission to present.
//
// The banner and the rewarded-video path in the main menu are untouched, since
// neither can interrupt a level.

const log = require('../core/log');

let originalImp = null;
let swizzledImp = null; // retained so the callback is not collected
let method = null;

// Blocking defaults to on. An ad landing mid-run ruins the run, and having to
// remember to re-enable it after every crash was its own small tax.
const state = { installed: false, blocking: true };

function install() {
    if (state.installed) return true;
    if (!ObjC.available || ObjC.classes.EAGLView === undefined) return false;

    method = ObjC.classes.EAGLView['- shouldDisplayInterstitial:'];
    if (method === undefined) {
        log.warn('shouldDisplayInterstitial: not found; ad blocking unavailable', 'ads');
        return false;
    }

    originalImp = method.implementation;
    swizzledImp = ObjC.implement(method, function (handle, selector, arg) {
        if (state.blocking) return 0;
        return originalImp(handle, selector, arg);
    });
    method.implementation = swizzledImp;
    state.installed = true;
    log.info('interstitial gate hooked', 'ads');
    return true;
}

function uninstall() {
    if (!state.installed || method === null) return;
    method.implementation = originalImp;
    state.installed = false;
    swizzledImp = null;
}

function setBlocking(value) {
    state.blocking = !!value;
    if (state.blocking) install();
}

module.exports = { state, install, uninstall, setBlocking };
