// The warp line drawn over the actual game view.
//
// Markers are plain UIViews positioned from game/camera.js, which rebuilds the
// view-projection from the scene's own active camera. The overlay is
// pass-through - it never takes touches - so it changes nothing about how the
// game plays.
//
// Performance mattered more than it looked like it would. Every property set on
// a UIView is an ObjC bridge call, and the first version did three of them per
// dot per refresh plus a redundant second projection of every point, which is
// where the lag came from. Now each point is projected once, corner radii are
// set at build time instead of per frame, the dot count is halved, and the whole
// thing early-outs the moment it is hidden.
//
// The white dot sits on the ball's own world position, so if the projection is
// mirrored or rotated for this device it is immediately obvious and the
// orientation is visible immediately from the ball dot.

const theme = require('./theme');
const w = require('./widgets');
const log = require('../core/log');
const ball = require('../game/ball');
const camera = require('../game/camera');
const deathwarp = require('../tas/deathwarp');

const RAY_DOTS = 8;
const DOT = 9;
const MARGIN = 240;      // how far off-screen a marker may sit before hiding
const MIN_REFRESH_MS = 200; // the overlay is a hint, not a frame-exact HUD

const ui = {
    root: null,
    rayDots: [],
    flatDots: [],
    finish: null,
    respawn: null,
    ballDot: null,
};

const perf = { last: 0, worst: 0, calls: 0, lastDraw: 0 };

function yellow(alpha) {
    return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.85, 0.15, alpha);
}

function marker(size, color) {
    const v = w.view([[0, 0], [size, size]], color, size / 2);
    v.setHidden_(true);
    v.setUserInteractionEnabled_(false);
    return v;
}

function build(window) {
    const bounds = window.bounds();
    ui.root = w.view([[0, 0], [bounds[1][0], bounds[1][1]]], null, 0);
    ui.root.setUserInteractionEnabled_(false);
    ui.root.setHidden_(true);

    // The 3D ray from the respawn through the base of the finish pedestal.
    for (let i = 0; i < RAY_DOTS; i++) {
        const dot = marker(DOT, yellow(0.7));
        ui.rayDots.push(dot);
        ui.root.addSubview_(dot);
    }

    // The same ray flattened onto the ground plane at the measured kill height.
    // On level 9 this is the one that lines up with real warps; the 3D ray there
    // climbs into the sky.
    for (let i = 0; i < RAY_DOTS; i++) {
        const dot = marker(DOT,
            ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.2, 1.0, 0.5, 0.65));
        ui.flatDots.push(dot);
        ui.root.addSubview_(dot);
    }

    ui.finish = marker(15, theme.accent);
    ui.respawn = marker(13,
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.35, 0.6, 1.0, 1.0));
    ui.ballDot = marker(11, ObjC.classes.UIColor.whiteColor());
    [ui.finish, ui.respawn, ui.ballDot].forEach(v => ui.root.addSubview_(v));

    window.addSubview_(ui.root);
    return ui.root;
}

// One projection, one setFrame, nothing else.
function place(view, worldPoint, cam) {
    if (worldPoint === null) { view.setHidden_(true); return; }

    const p = camera.project(worldPoint, cam);
    if (p === null || p.x < -MARGIN || p.y < -MARGIN
        || p.x > cam.width + MARGIN || p.y > cam.height + MARGIN) {
        view.setHidden_(true);
        return;
    }

    const s = view.frame()[1][0];
    view.setFrame_([[p.x - s / 2, p.y - s / 2], [s, s]]);
    view.setHidden_(false);
}

function hideAll() {
    ui.rayDots.forEach(d => d.setHidden_(true));
    ui.flatDots.forEach(d => d.setHidden_(true));
    [ui.finish, ui.respawn, ui.ballDot].forEach(v => v.setHidden_(true));
}

function refresh() {
    if (ui.root === null || ui.root.isHidden()) return;

    const now = Date.now();
    if (now - perf.lastDraw < MIN_REFRESH_MS) return;
    perf.lastDraw = now;

    const started = now;
    try {
        draw();
    } catch (err) {
        log.error('overlay.refresh', err);
        setVisible(false);
        return;
    }

    perf.last = Date.now() - started;
    perf.calls += 1;
    if (perf.last > perf.worst) {
        perf.worst = perf.last;
        if (perf.last > 40) {
            log.warn(`3D ray refresh took ${perf.last}ms`, 'overlay');
        }
    }
}

function draw() {
    if (!ball.levelLoaded()) { hideAll(); return; }

    const bounds = ui.root.bounds();
    const cam = camera.snapshot({ width: bounds[1][0], height: bounds[1][1] });
    if (cam === null) { hideAll(); return; }

    place(ui.ballDot, ball.physicsPosition(), cam);

    const c = deathwarp.corridor();
    if (c === null) {
        ui.rayDots.forEach(d => d.setHidden_(true));
        ui.flatDots.forEach(d => d.setHidden_(true));
        [ui.finish, ui.respawn].forEach(v => v.setHidden_(true));
        return;
    }

    place(ui.finish, c.finish, cam);
    place(ui.respawn, c.respawn, cam);

    const kill = deathwarp.killPlane();
    const step = Math.max(c.startDistance / 4, 20);

    for (let i = 0; i < RAY_DOTS; i++) {
        const distance = (i + 1) * step;

        place(ui.rayDots[i], {
            x: c.finish.x + c.direction.x * distance,
            y: c.finish.y + c.direction.y * distance,
            z: c.finish.z + c.direction.z * distance,
        }, cam);

        if (kill === null) {
            ui.flatDots[i].setHidden_(true);
        } else {
            place(ui.flatDots[i], {
                x: c.finish.x + c.flat.x * distance,
                y: kill.y,
                z: c.finish.z + c.flat.z * distance,
            }, cam);
        }
    }
}

function setVisible(value) {
    if (ui.root === null) return;
    ui.root.setHidden_(!value);
    if (!value) hideAll();
    else { perf.worst = 0; perf.calls = 0; }
}

function isVisible() { return ui.root !== null && !ui.root.isHidden(); }

module.exports = { build, refresh, setVisible, isVisible, ui, perf };
