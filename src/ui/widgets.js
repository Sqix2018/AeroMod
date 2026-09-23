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

        // center, not frame: AeroMod views are scaled (see UI scale above).
        const c = movable.center();
        movable.setCenter_([c[0] + t[0], c[1] + t[1]]);
        g.setTranslation_inView_([0, 0], parent);
    });

    handle.addGestureRecognizer_(gesture);
    handle.setUserInteractionEnabled_(true);
    return gesture;
}

// ------------------------------------------------------------- UI scale
//
// Builders get uiRoot() instead of the window: it reports a bigger virtual
// screen (window size / scale), and every view added through it is scaled by
// `scale` around its top-left corner with its position scaled to match. So
// everything shrinks uniformly - text, buttons, borders, map, pad - and
// layouts designed for a large screen fit a phone.
//
// Each view stays a direct child of the window, so touches are handled by
// UIKit as usual. (A scaled full-screen container needed a hitTest: override
// to let taps through to the game, and that override crashed on every tap.)
// A scaled view's frame is not reliable: move it with setCenter_ (drag) or
// placeView() below.

const SCALE_FILE = 'ui-scale.json';
const SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const scale = { value: null, applied: 1.0, window: null, root: null, views: [] };

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

function virtualSize() {
    const b = scale.window.bounds();
    const s = scale.applied;
    return [b[1][0] / s, b[1][1] / s];
}

// Scale `view` (already on the window, identity transform) and keep its
// virtual frame: origin (x, y) in virtual points -> window points x*s, y*s.
function adopt(view) {
    const s = scale.applied;
    const f = view.frame();
    const [vw, vh] = virtualSize();
    const full = Math.abs(f[1][0] - vw) < 1 && Math.abs(f[1][1] - vh) < 1;
    view.layer().setAnchorPoint_([0, 0]);
    view.setCenter_([f[0][0] * s, f[0][1] * s]);
    view.setTransform_([s, 0, 0, s, 0, 0]);
    scale.views.push({ view, full });
}

// Set a scaled view's frame in virtual points.
function placeView(view, frame) {
    const s = scale.applied;
    view.setBounds_([[0, 0], [frame[1][0], frame[1][1]]]);
    view.setCenter_([frame[0][0] * s, frame[0][1] * s]);
}

// Stand-in for the window that builders add their views to.
function uiRoot() {
    const win = keyWindow();
    if (win === null) return null;
    if (scale.root !== null && scale.window !== null && scale.window.handle.equals(win.handle)) {
        return scale.root;
    }
    scale.window = win;
    scale.applied = uiScale();
    scale.views = [];
    scale.root = {
        handle: win.handle,
        bounds: () => [[0, 0], virtualSize()],
        addSubview_: (view) => { win.addSubview_(view); adopt(view); },
        bringSubviewToFront_: (view) => win.bringSubviewToFront_(view),
    };
    return scale.root;
}

function setUiScale(v) {
    const n = Number(v);
    if (!(n >= 0.3 && n <= 1.5)) return uiScale();
    scale.value = n;
    try { require('../core/storage').writeJson(SCALE_FILE, { scale: n }); } catch (err) { /* */ }
    if (scale.window === null) return n;
    const old = scale.applied;
    scale.applied = n;
    const [vw, vh] = virtualSize();
    scale.views = scale.views.filter(e => {
        try {
            if (e.view.superview() === null) return false;
            const c = e.view.center();
            e.view.setTransform_([n, 0, 0, n, 0, 0]);
            e.view.setCenter_([c[0] / old * n, c[1] / old * n]);
            if (e.full) e.view.setBounds_([[0, 0], [vw, vh]]);
            return true;
        } catch (err) {
            return false;
        }
    });
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
    uiRoot, uiScale, setUiScale, placeView, SCALES,
};
