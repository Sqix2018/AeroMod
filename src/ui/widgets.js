// Thin UIKit factories plus a single target/action bridge.
//
// addTarget:action:forControlEvents: is used rather than UIAction because the
// D-pad needs separate touch-down and touch-up events for press-and-hold, which
// UIAction does not give you.

const theme = require('./theme');

// Everything handed to ObjC is retained here so Frida's GC cannot collect it
// while UIKit still holds a reference.
const retained = [];

const handlers = {};  // sender handle -> { down, up, change, tap }

let Target = null;
let target = null;

function ensureTarget() {
    if (target !== null) return target;

    function dispatch(kind) {
        return function (sender) {
            const entry = handlers[sender.handle.toString()];
            if (entry === undefined || entry[kind] === undefined) return;
            try { entry[kind](sender); } catch (err) {
                console.log(`[aerox-tas] ui ${kind}: ${err.message}`);
            }
        };
    }

    Target = ObjC.registerClass({
        name: 'AeroxTASTarget',
        super: ObjC.classes.NSObject,
        methods: {
            '- onTap:': { retType: 'void', argTypes: ['object'], implementation: dispatch('tap') },
            '- onDown:': { retType: 'void', argTypes: ['object'], implementation: dispatch('down') },
            '- onUp:': { retType: 'void', argTypes: ['object'], implementation: dispatch('up') },
            '- onChange:': { retType: 'void', argTypes: ['object'], implementation: dispatch('change') },
            '- onPan:': { retType: 'void', argTypes: ['object'], implementation: dispatch('change') },
        },
    });

    target = Target.alloc().init();
    retained.push(target);
    return target;
}

const EVENT = {
    touchDown: 1 << 0,
    touchUpInside: 1 << 6,
    touchUpOutside: 1 << 7,
    touchCancel: 1 << 8,
    valueChanged: 1 << 12,
};

function register(sender, kind, fn) {
    const key = sender.handle.toString();
    if (handlers[key] === undefined) handlers[key] = {};
    handlers[key][kind] = fn;
    retained.push(sender);
}

function view(frame, color, corner) {
    const v = ObjC.classes.UIView.alloc().initWithFrame_(frame);
    if (color !== undefined && color !== null) v.setBackgroundColor_(color);
    v.layer().setCornerRadius_(corner === undefined ? theme.corner : corner);
    v.setClipsToBounds_(true);
    return v;
}

function label(frame, text, opts) {
    const o = opts || {};
    const l = ObjC.classes.UILabel.alloc().initWithFrame_(frame);
    l.setText_(text);
    l.setTextColor_(o.color || theme.text);
    l.setFont_(o.font || (o.mono ? theme.monoFont
        : ObjC.classes.UIFont.systemFontOfSize_(o.size || 13)));
    l.setNumberOfLines_(o.lines || 1);
    if (o.center) l.setTextAlignment_(1);
    return l;
}

function button(frame, title, onTap, opts) {
    const o = opts || {};
    const b = ObjC.classes.UIButton.buttonWithType_(1); // UIButtonTypeSystem
    b.setFrame_(frame);
    b.setTitle_forState_(title, 0);
    b.setTitleColor_forState_(o.color || theme.text, 0);
    b.titleLabel().setFont_(
        ObjC.classes.UIFont.systemFontOfSize_(o.size || 14));
    b.setBackgroundColor_(o.background || theme.surfaceAlt);
    b.layer().setCornerRadius_(o.corner === undefined ? 8 : o.corner);

    if (onTap !== undefined && onTap !== null) {
        register(b, 'tap', onTap);
        b.addTarget_action_forControlEvents_(ensureTarget(), ObjC.selector('onTap:'),
            EVENT.touchUpInside);
    }
    return b;
}

// Press-and-hold button: fires onDown on press, onUp on release/cancel.
function holdButton(frame, title, onDown, onUp, opts) {
    const b = button(frame, title, null, opts);
    const t = ensureTarget();
    register(b, 'down', onDown);
    register(b, 'up', onUp);
    b.addTarget_action_forControlEvents_(t, ObjC.selector('onDown:'), EVENT.touchDown);
    b.addTarget_action_forControlEvents_(t, ObjC.selector('onUp:'),
        EVENT.touchUpInside | EVENT.touchUpOutside | EVENT.touchCancel);
    return b;
}

function slider(frame, min, max, value, onChange) {
    const s = ObjC.classes.UISlider.alloc().initWithFrame_(frame);
    s.setMinimumValue_(min);
    s.setMaximumValue_(max);
    s.setValue_(value);
    s.setMinimumTrackTintColor_(theme.accent);
    register(s, 'change', onChange);
    s.addTarget_action_forControlEvents_(ensureTarget(), ObjC.selector('onChange:'),
        EVENT.valueChanged);
    return s;
}

function scrollView(frame, color, corner) {
    const s = ObjC.classes.UIScrollView.alloc().initWithFrame_(frame);
    if (color !== undefined && color !== null) s.setBackgroundColor_(color);
    s.layer().setCornerRadius_(corner === undefined ? theme.corner : corner);
    s.setClipsToBounds_(true);
    s.setShowsVerticalScrollIndicator_(true);
    s.setAlwaysBounceVertical_(true);
    return s;
}

function textField(frame, placeholder) {
    const tf = ObjC.classes.UITextField.alloc().initWithFrame_(frame);
    tf.setPlaceholder_(placeholder);
    tf.setFont_(ObjC.classes.UIFont.systemFontOfSize_(13));
    tf.setTextColor_(theme.text);
    tf.setBackgroundColor_(theme.surfaceAlt);
    tf.layer().setCornerRadius_(6);
    tf.setBorderStyle_(0);
    tf.setTextAlignment_(1);
    tf.setKeyboardType_(4); // numbers and punctuation
    tf.setKeyboardAppearance_(1); // dark
    return tf;
}

// Makes `handle` drag `movable` around the screen.
function makeDraggable(handle, movable) {
    const t = ensureTarget();
    const gesture = ObjC.classes.UIPanGestureRecognizer.alloc()
        .initWithTarget_action_(t, ObjC.selector('onPan:'));

    // Consume the translation on every callback and reset it to zero, so each
    // update is a delta applied to wherever the view currently is. Caching the
    // origin on UIGestureRecognizerStateBegan does not work here: the first
    // callback can arrive already in Changed, leaving the cached origin at the
    // default and snapping the view to the top-left corner.
    register(gesture, 'change', function (g) {
        const parent = movable.superview();
        if (parent === null) return;

        const t = g.translationInView_(parent);
        if (t[0] === 0 && t[1] === 0) return;

        const f = movable.frame();
        movable.setFrame_([[f[0][0] + t[0], f[0][1] + t[1]], [f[1][0], f[1][1]]]);
        g.setTranslation_inView_([0, 0], parent);
    });

    handle.addGestureRecognizer_(gesture);
    handle.setUserInteractionEnabled_(true);
    return gesture;
}

// ------------------------------------------------------------- UI scale
//
// Every AeroMod view lives in one full-screen container instead of on the
// window. The container is laid out as a bigger virtual screen (window size /
// scale) and then scaled down by `scale`, so everything shrinks uniformly -
// text, buttons, borders, map, pad - and layouts designed for a large screen fit a
// phone. Touches that land on no AeroMod view pass through to the game.

const SCALE_FILE = 'ui-scale.json';
const SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const scale = { value: null, root: null, window: null };

function defaultScale(win) {
    try {
        const b = win.bounds();
        const shortSide = Math.min(b[1][0], b[1][1]);
        return shortSide < 600 ? 0.7 : 1.0; // phones vs tablets (points)
    } catch (err) {
        return 1.0;
    }
}

function uiScale() {
    if (scale.value === null) {
        let saved = null;
        try { saved = require('../core/storage').readJson(SCALE_FILE); } catch (err) { /* */ }
        const v = saved && Number(saved.scale);
        scale.value = (v >= 0.3 && v <= 1.5) ? v : null;
    }
    if (scale.value === null && scale.window !== null) scale.value = defaultScale(scale.window);
    return scale.value === null ? 1.0 : scale.value;
}

function rootClass() {
    if (ObjC.classes.AeroModRoot !== undefined) return ObjC.classes.AeroModRoot;
    return ObjC.registerClass({
        name: 'AeroModRoot',
        super: ObjC.classes.UIView,
        methods: {
            // Our views get their touches; empty space goes to the game.
            '- hitTest:withEvent:': {
                types: '@@:{CGPoint=dd}@',
                implementation: function (point, event) {
                    const hit = this.super.hitTest_withEvent_(point, event);
                    if (hit === null || hit.handle.equals(this.self.handle)) return NULL;
                    return hit;
                },
            },
        },
    });
}

function layoutRoot() {
    const root = scale.root;
    const win = scale.window;
    if (root === null || win === null) return;
    const s = uiScale();
    const b = win.bounds();
    root.setTransform_([1, 0, 0, 1, 0, 0]);
    root.layer().setAnchorPoint_([0, 0]);
    root.setBounds_([[0, 0], [b[1][0] / s, b[1][1] / s]]);
    root.layer().setPosition_([0, 0]);
    root.setTransform_([s, 0, 0, s, 0, 0]);
}

// The container every AeroMod view is added to (created on first use).
function uiRoot() {
    const win = keyWindow();
    if (win === null) return null;
    if (scale.root !== null && scale.window !== null && scale.window.handle.equals(win.handle)) {
        return scale.root;
    }
    const root = rootClass().alloc().initWithFrame_(win.bounds());
    root.setBackgroundColor_(ObjC.classes.UIColor.clearColor());
    root.setUserInteractionEnabled_(true);
    win.addSubview_(root);
    retained.push(root);
    scale.root = root;
    scale.window = win;
    layoutRoot();
    return root;
}

function setUiScale(v) {
    const n = Number(v);
    if (!(n >= 0.3 && n <= 1.5)) return uiScale();
    scale.value = n;
    try { require('../core/storage').writeJson(SCALE_FILE, { scale: n }); } catch (err) { /* */ }
    layoutRoot();
    return n;
}

function keyWindow() {
    const app = ObjC.classes.UIApplication.sharedApplication();
    const windows = app.windows();
    for (let i = 0; i < windows.count(); i++) {
        const w = windows.objectAtIndex_(i);
        if (w.isKeyWindow()) return w;
    }
    return ObjC.classes.UIWindow.keyWindow();
}

module.exports = {
    EVENT, view, label, button, holdButton, slider, textField, scrollView,
    makeDraggable, keyWindow, retained, register, ensureTarget,
    uiRoot, uiScale, setUiScale, SCALES,
};
