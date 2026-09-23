// Tap-to-pick teleport coordinates.
//
// This is a plan view of the level built from the scene's own geometry rather
// than a hijack of the game camera. Pointing the real camera straight down would
// mean fighting processGameFrame, which rebuilds the camera transform from the
// ball and the yaw every frame, and then inverting its projection to turn a tap
// back into a world position. The plan view gives the same workflow - see the
// whole level, tap a spot, get X and Z - with exact arithmetic and nothing
// touched in the game.
//
// Y is left to you, because a plan view genuinely cannot tell you a height.
// The picker seeds it with the ball's current Y so the common case is one tap.

const theme = require('./theme');
const w = require('./widgets');
const ball = require('../game/ball');
const extents = require('../game/extents');
const deathwarp = require('../tas/deathwarp');

const PAD = 28;
const GRID_LINES = 8;

const ui = {
    root: null,
    canvas: null,
    readout: null,
    crosshair: null,
    dots: [],
    onPick: null,
};

let projector = null;

function dim(alpha) {
    return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.0, 0.0, 0.0, alpha);
}

function build(window) {
    const bounds = window.bounds();
    const width = bounds[1][0];
    const height = bounds[1][1];

    ui.root = w.view([[0, 0], [width, height]], dim(0.82), 0);
    ui.root.setHidden_(true);

    // Lay out from the chrome inwards, not from the screen size outwards. The
    // first version sized the grid to min(width, height) - 90 and then stacked a
    // title above it and buttons below, which pushed the buttons off the bottom
    // in landscape where height *is* the smaller dimension.
    const TITLE_SPACE = 52;     // heading + readout above the grid
    const BUTTON_SPACE = 20 + theme.TOUCH;
    const MARGIN = 20;

    const side = Math.max(120, Math.min(
        width - MARGIN * 2,
        height - TITLE_SPACE - BUTTON_SPACE - MARGIN * 2));

    const left = (width - side) / 2;
    const top = MARGIN + TITLE_SPACE
        + Math.max(0, (height - TITLE_SPACE - BUTTON_SPACE - MARGIN * 2 - side) / 2);

    ui.canvas = w.view([[left, top], [side, side]], theme.surface, 10);
    ui.root.addSubview_(ui.canvas);

    const line = ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1, 1, 1, 0.07);
    for (let i = 1; i < GRID_LINES; i++) {
        const at = (side / GRID_LINES) * i;
        ui.canvas.addSubview_(w.view([[at, 0], [1, side]], line, 0));
        ui.canvas.addSubview_(w.view([[0, at], [side, 1]], line, 0));
    }

    ui.crosshair = w.view([[0, 0], [18, 18]], null, 9);
    ui.crosshair.layer().setBorderWidth_(2);
    ui.crosshair.layer().setBorderColor_(theme.accent.CGColor());
    ui.crosshair.setHidden_(true);
    ui.canvas.addSubview_(ui.crosshair);

    ui.root.addSubview_(w.label([[0, top - 48], [width, 22]],
        'Tap a spot to set X and Z', { size: 16, center: true }));

    ui.readout = w.label([[0, top - 24], [width, 20]], '',
        { size: 12, mono: true, color: theme.accent, center: true });
    ui.root.addSubview_(ui.readout);

    const buttonTop = Math.min(top + side + 12, height - MARGIN - theme.TOUCH);
    ui.root.addSubview_(w.button([[left, buttonTop], [side / 2 - 6, theme.TOUCH]],
        'Cancel', () => close(), { size: 15 }));

    ui.root.addSubview_(w.button(
        [[left + side / 2 + 6, buttonTop], [side / 2 - 6, theme.TOUCH]],
        'Use this spot', () => commit(), { size: 15, background: theme.accentDim }));

    // Attached to the canvas rather than the dots: a recognizer on an ancestor
    // still sees touches that land on its subviews, so the point cloud stays inert.
    attachTap(ui.canvas);

    window.addSubview_(ui.root);
    return ui.root;
}

let picked = null;

function attachTap(view) {
    const gesture = ObjC.classes.UITapGestureRecognizer.alloc()
        .initWithTarget_action_(w.ensureTarget(), ObjC.selector('onPan:'));

    w.register(gesture, 'change', function (g) {
        if (projector === null) return;
        const point = g.locationInView_(ui.canvas);
        const world = projector.toWorld({ x: point[0], y: point[1] });
        picked = world;

        ui.crosshair.setFrame_([[point[0] - 9, point[1] - 9], [18, 18]]);
        ui.crosshair.setHidden_(false);
        ui.readout.setText_(`X ${world.x.toFixed(2)}    Z ${world.z.toFixed(2)}`);
    });

    view.addGestureRecognizer_(gesture);
    view.setUserInteractionEnabled_(true);
}

function clearDots() {
    ui.dots.forEach(d => d.removeFromSuperview());
    ui.dots = [];
}

function addDot(position, size, color) {
    if (position === null || projector === null) return;
    const p = projector.toScreen(position);
    const dot = w.view([[p.x - size / 2, p.y - size / 2], [size, size]], color, size / 2);
    dot.setUserInteractionEnabled_(false);
    ui.canvas.addSubview_(dot);
    ui.dots.push(dot);
}

function open(onPick) {
    if (ui.root === null) return false;
    if (!ball.levelLoaded()) return false;

    const side = ui.canvas.frame()[1][0];
    projector = extents.projector(side, PAD);
    if (projector === null) return false;

    ui.onPick = onPick || null;
    picked = null;
    ui.crosshair.setHidden_(true);
    clearDots();

    // Level geometry as a faint point cloud, so the shape of the map is legible.
    const faint = ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1, 1, 1, 0.18);
    projector.bounds.models.forEach(m => addDot(m.position, 3, faint));

    const f = deathwarp.finish();
    if (f !== null) addDot(f.position, 11, theme.accent);
    addDot(deathwarp.respawn(), 9,
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.35, 0.6, 1.0, 1.0));

    const solution = deathwarp.solve();
    if (solution.feasible) {
        addDot(solution.point, 13,
            ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.85, 0.15, 0.9));
    }

    const p = ball.physicsPosition();
    addDot(p, 10, ObjC.classes.UIColor.whiteColor());

    ui.readout.setText_(p === null ? '' : `ball at X ${p.x.toFixed(2)}  Z ${p.z.toFixed(2)}`);
    ui.root.setHidden_(false);
    ui.root.superview().bringSubviewToFront_(ui.root);
    return true;
}

// The callback gets the chosen position, or null if it was cancelled, so the
// caller can put its own UI back either way.
function commit() {
    const current = ball.physicsPosition();
    const chosen = picked === null ? null
        : { x: picked.x, y: current === null ? 0 : current.y, z: picked.z };
    finishWith(chosen);
}

function close() { finishWith(null); }

function finishWith(chosen) {
    const handler = ui.onPick;
    ui.onPick = null;
    if (ui.root !== null) ui.root.setHidden_(true);
    clearDots();
    projector = null;
    if (handler !== null && handler !== undefined) handler(chosen);
}

function isOpen() { return ui.root !== null && !ui.root.isHidden(); }

module.exports = { build, open, close, isOpen, ui };
