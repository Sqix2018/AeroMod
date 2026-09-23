// Hardware keyboard support for iPad.
//
// A paired Bluetooth keyboard is by far the best way to drive this: arrows for
// tilt, space to pause, and a key to step a frame, all without touching the
// screen. Implemented as our own first-responder view so the game's classes are
// left alone. Silently does nothing if no keyboard is attached.
//
// UIPress.key requires iOS 13.4+.

const input = require('../game/input');
const frame = require('../game/frame');
const splits = require('../tas/splits');

// UIKeyboardHIDUsage values.
const KEY = {
    right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
    space: 0x2c, period: 0x37, comma: 0x36,
    one: 0x1e, two: 0x1f, three: 0x20, four: 0x21,
    s: 0x16, l: 0x0f, n: 0x11, b: 0x05,
};

const state = { enabled: false, view: null };

function handle(keyCode, down) {
    if (!state.enabled) return false;

    switch (keyCode) {
        case KEY.left: input.hold('left', down); return true;
        case KEY.right: input.hold('right', down); return true;
        case KEY.up: input.hold('up', down); return true;
        case KEY.down: input.hold('down', down); return true;
        case KEY.b:
            if (!input.altBrakeOn()) return false;
            input.setBrake(down);
            return true;
        default: break;
    }

    if (!down) return false;

    switch (keyCode) {
        case KEY.space: frame.togglePaused(); return true;
        case KEY.period: frame.advance(1); return true;
        case KEY.comma: frame.advance(10); return true;
        case KEY.n: splits.teleportToNext(); return true;
        default: return false;
    }
}

function pressesHandler(down) {
    return function (presses) {
        let handled = false;
        try {
            const all = presses.allObjects();
            const count = all.count();
            for (let i = 0; i < count; i++) {
                const press = all.objectAtIndex_(i);
                if (typeof press.key !== 'function') continue;
                const key = press.key();
                if (key === null) continue;
                if (handle(key.keyCode(), down)) handled = true;
            }
        } catch (err) {
            console.log(`[aerox-tas] key event: ${err.message}`);
        }
        return handled;
    };
}

let KeyView = null;

function build(window) {
    if (ObjC.classes.AeroxTASKeyView === undefined) {
        const onDown = pressesHandler(true);
        const onUp = pressesHandler(false);
        KeyView = ObjC.registerClass({
            name: 'AeroxTASKeyView',
            super: ObjC.classes.UIView,
            methods: {
                '- canBecomeFirstResponder': {
                    retType: 'bool', argTypes: [], implementation: () => true,
                },
                '- pressesBegan:withEvent:': {
                    retType: 'void', argTypes: ['object', 'object'],
                    implementation(presses) { onDown(presses); },
                },
                '- pressesEnded:withEvent:': {
                    retType: 'void', argTypes: ['object', 'object'],
                    implementation(presses) { onUp(presses); },
                },
                '- pressesCancelled:withEvent:': {
                    retType: 'void', argTypes: ['object', 'object'],
                    implementation(presses) { onUp(presses); },
                },
            },
        });
    } else {
        KeyView = ObjC.classes.AeroxTASKeyView;
    }

    // Zero-size and non-interactive: it exists only to sit in the responder chain.
    state.view = KeyView.alloc().initWithFrame_([[0, 0], [0, 0]]);
    state.view.setUserInteractionEnabled_(false);
    window.addSubview_(state.view);
}

function setEnabled(value) {
    state.enabled = !!value;
    if (state.view !== null) {
        if (state.enabled) state.view.becomeFirstResponder();
        else { state.view.resignFirstResponder(); input.releaseAll(); }
    }
    try { input.publishNative(); } catch (err) { /* */ }
    try { require('../game/frame').syncHot(); } catch (err) { /* */ }
}

module.exports = { build, setEnabled, state, KEY };
