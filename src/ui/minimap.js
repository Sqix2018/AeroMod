// Top-down view of the level, showing where deaths actually happened.
//
// Y is up in Aerox, so the ground plane is XZ and a plan view is the honest way
// to show this. What it draws changed after the level 9 data came in: it used to
// draw a predicted corridor from a model that turned out to be wrong, and now it
// draws the ground-plane ray as a hypothesis plus every death that has actually
// been recorded - red for a normal death, green for one that warped.
//
// That inverts the tool. Instead of telling you where the warp should be, it
// accumulates where it was, and the pattern is visible whether or not anyone has
// the right model yet.

const theme = require('./theme');
const w = require('./widgets');
const log = require('../core/log');
const ball = require('../game/ball');
const deathwarp = require('../tas/deathwarp');
const warplog = require('../tas/warplog');
const splits = require('../tas/splits');

const SIZE = 196;
const PAD = 10;
const MAX_MARKS = 256;
const MAX_MOVABLES = 8;

const ui = {
    box: null,
    plane: null,
    zone: null,       // predicted warp zone for this level/layer (warpzones.js)
    marks: [],
    movables: [],
    voidDot: null,
    splitMarks: [],
    finishDot: null,
    respawnDot: null,
    ballDot: null,
    title: null,
};

const drawCache = { stamp: -1, layer: null, mapper: null, locked: null, zone: null };

function dot(size, color) {
    const v = w.view([[0, 0], [size, size]], color, size / 2);
    v.setHidden_(true);
    return v;
}

const GREEN = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.2, 1.0, 0.5, 1.0);
const RED = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.3, 0.3, 0.8);
const ORANGE = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.55, 0.15, 0.95);

function build(window) {
    ui.box = w.view([[24, 168], [SIZE, SIZE + 22]], theme.background);
    ui.box.setClipsToBounds_(false);

    ui.title = w.label([[0, 3], [SIZE, 16]], 'WARP MAP',
        { size: 10, color: theme.textDim, center: true });
    ui.box.addSubview_(ui.title);

    ui.plane = w.view([[0, 20], [SIZE, SIZE]], null, 0);
    ui.plane.setClipsToBounds_(false);
    ui.box.addSubview_(ui.plane);

    // Behind everything else: the exact zone where an armed death can warp.
    ui.zone = w.view([[0, 0], [1, 1]],
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.2, 1.0, 0.5, 0.16), 0);
    ui.zone.setHidden_(true);
    ui.plane.addSubview_(ui.zone);

    for (let i = 0; i < MAX_MOVABLES; i++) {
        const cell = w.view([[0, 0], [6, 6]], ORANGE(), 1);
        cell.setHidden_(true);
        ui.movables.push(cell);
        ui.plane.addSubview_(cell);
    }

    for (let i = 0; i < MAX_MARKS; i++) {
        const mark = w.view([[0, 0], [7, 7]], RED(), 1);
        mark.setHidden_(true);
        ui.marks.push(mark);
        ui.plane.addSubview_(mark);
    }

    ui.respawnDot = dot(7,
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.35, 0.6, 1.0, 1.0));
    ui.finishDot = dot(9, theme.accent);
    ui.ballDot = dot(8, ObjC.classes.UIColor.whiteColor());
    ui.splitMarks = [];
    for (let i = 0; i < 12; i++) {
        const mark = w.view([[0, 0], [8, 8]],
            ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.45, 0.7, 1.0, 0.32), 2);
        mark.setHidden_(true);
        ui.splitMarks.push(mark);
        ui.plane.addSubview_(mark);
    }
    [ui.respawnDot, ui.finishDot, ui.ballDot]
        .forEach(d => ui.plane.addSubview_(d));

    // Off until asked for, so a fresh install shows nothing but the TAS pill.
    ui.box.setHidden_(true);

    window.addSubview_(ui.box);
    w.makeDraggable(ui.box, ui.box);
    return ui.box;
}

function place(view, position, mapper) {
    if (position === null) { view.setHidden_(true); return; }
    const p = mapper.toScreen(position);
    const f = view.frame();
    view.setFrame_([[p.x - f[1][0] / 2, p.y - f[1][1] / 2], [f[1][0], f[1][1]]]);
    view.setHidden_(false);
}

function hideAll() {
    if (ui.zone !== null) ui.zone.setHidden_(true);
    ui.movables.forEach(c => c.setHidden_(true));
    ui.marks.forEach(m => m.setHidden_(true));
    if (ui.splitMarks) ui.splitMarks.forEach(m => m.setHidden_(true));
    [ui.finishDot, ui.respawnDot, ui.ballDot].forEach(d => d.setHidden_(true));
}

function refresh() {
    if (ui.box === null || ui.box.isHidden()) return;
    try { draw(); } catch (err) {
        log.error('minimap.refresh', err);
        setVisible(false);
    }
}

function probing() {
    return deathwarp.autoOn() || deathwarp.autoVoidOn();
}

function mapProjector() {
    // AUTO reloads through the menu every try. Refitting the grid each time
    // slides every dot, which is the refresh that hides new marks.
    const levelId = warplog.state.level;
    if (!probing()) {
        drawCache.locked = null;
    } else if (drawCache.locked && drawCache.locked.level === levelId) {
        return drawCache.locked.mapper;
    }
    const box = deathwarp.probeBounds();
    if (box === null) return null;
    let minX = box.minX;
    let maxX = box.maxX;
    let minZ = box.minZ;
    let maxZ = box.maxZ;
    warplog.layerHits().forEach(h => {
        if (h.position === null) return;
        if (h.position.x < minX) minX = h.position.x;
        if (h.position.x > maxX) maxX = h.position.x;
        if (h.position.z < minZ) minZ = h.position.z;
        if (h.position.z > maxZ) maxZ = h.position.z;
    });
    const slack = box.step * 0.5;
    minX -= slack;
    maxX += slack;
    minZ -= slack;
    maxZ += slack;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    const originX = (minX + maxX) / 2 - span / 2;
    const originZ = (minZ + maxZ) / 2 - span / 2;
    const scale = (SIZE - PAD * 2) / span;
    const mapper = {
        key: `${originX.toFixed(1)},${originZ.toFixed(1)},${span.toFixed(1)}`,
        scale,
        toScreen(position) {
            return {
                x: PAD + (position.x - originX) * scale,
                y: PAD + (position.z - originZ) * scale,
            };
        },
    };
    if (probing() && ball.levelLoaded()) {
        drawCache.locked = { level: levelId, mapper };
    }
    return mapper;
}

function pickShown(hits, max) {
    const warps = hits.filter(h => h.warp);
    const fails = hits.filter(h => !h.warp);
    if (warps.length + fails.length <= max) return warps.concat(fails);
    const room = Math.max(max - warps.length, 0);
    if (room === 0) return warps.slice(0, max);
    if (fails.length <= room) return warps.concat(fails);

    const picked = [];
    const used = {};
    function take(hit) {
        if (hit === null || hit.position === null) return;
        const k = `${hit.position.x},${hit.position.z}`;
        if (used[k]) return;
        used[k] = true;
        picked.push(hit);
    }

    let minX = fails[0], maxX = fails[0], minZ = fails[0], maxZ = fails[0];
    fails.forEach(h => {
        if (h.position.x < minX.position.x) minX = h;
        if (h.position.x > maxX.position.x) maxX = h;
        if (h.position.z < minZ.position.z) minZ = h;
        if (h.position.z > maxZ.position.z) maxZ = h;
    });
    [minX, maxX, minZ, maxZ].forEach(take);
    fails.slice(-Math.min(16, room)).forEach(take);

    const stride = fails.length / Math.max(room - picked.length, 1);
    for (let i = 0; picked.length < room && i < fails.length; i += stride) {
        take(fails[Math.floor(i)]);
    }
    return warps.concat(picked).slice(0, max);
}

function drawMarks(mapper, hits) {
    const cut = hits.slice(0, MAX_MARKS);
    const shown = cut.filter(h => !h.warp).concat(cut.filter(h => h.warp));
    for (let i = 0; i < MAX_MARKS; i++) {
        const mark = ui.marks[i];
        if (i >= shown.length) { mark.setHidden_(true); continue; }
        const hit = shown[i];
        const p = mapper.toScreen(hit.position);
        const size = hit.warp ? 5 : 4;
        mark.setFrame_([[p.x - size / 2, p.y - size / 2], [size, size]]);
        mark.setBackgroundColor_(hit.warp ? GREEN() : RED());
        mark.setHidden_(false);
    }
}

function draw() {
    try { warplog.syncLevel(); } catch (err) { /* */ }
    if (!ball.levelLoaded()) {
        // Menu between probe tries. Leave the marks where they are.
        if (probing() && drawCache.locked) return;
        ui.title.setText_('WARP MAP  -  no level');
        hideAll();
        return;
    }

    const mapper = mapProjector();
    if (mapper === null) {
        ui.title.setText_('WARP MAP  -  no level');
        hideAll();
        return;
    }

    const movers = deathwarp.usefulTargets().filter(m => m.last !== null);
    for (let i = 0; i < MAX_MOVABLES; i++) {
        const cell = ui.movables[i];
        if (i >= movers.length) {
            cell.setHidden_(true);
            continue;
        }
        const p = mapper.toScreen(movers[i].last);
        cell.setFrame_([[p.x - 3, p.y - 3], [6, 6]]);
        cell.setHidden_(false);
    }

    const layer = warplog.mapCheckpoint();
    let zoneTag = '';
    try {
        // Prefer the zone the last arm check measured live (EndFlare's real
        // box); the landmark estimate can be missing or off (L10).
        let z = null;
        const lz = deathwarp.state.liveZone;
        if (lz && lz.rect && lz.level === warplog.state.level && lz.cp === !!layer) {
            z = { ok: lz.ok, rect: lz.rect, text: lz.text, est: false };
        } else {
            z = require('../tas/warpzones').mapZone(warplog.state.level, layer);
        }
        if (z && z.ok) {
            const a = mapper.toScreen({ x: z.rect.minX, z: z.rect.minZ });
            const b = mapper.toScreen({ x: z.rect.maxX, z: z.rect.maxZ });
            const clamp = v => Math.max(0, Math.min(SIZE, v));
            const x0 = clamp(Math.min(a.x, b.x));
            const x1 = clamp(Math.max(a.x, b.x));
            const y0 = clamp(Math.min(a.y, b.y));
            const y1 = clamp(Math.max(a.y, b.y));
            const key = `${x0.toFixed(0)},${y0.toFixed(0)},${x1.toFixed(0)},${y1.toFixed(0)}`;
            if (drawCache.zone !== key) {
                ui.zone.setFrame_([[x0, y0], [Math.max(1, x1 - x0), Math.max(1, y1 - y0)]]);
                drawCache.zone = key;
            }
            ui.zone.setHidden_(false);
            zoneTag = z.est ? '  zone~' : '  zone';
        } else {
            ui.zone.setHidden_(true);
            drawCache.zone = null;
            zoneTag = z ? '  no warp' : '';
        }
    } catch (err) { /* */ }
    const stamp = warplog.state.markStamp;
    if (stamp !== drawCache.stamp || layer !== drawCache.layer
        || mapper.key !== drawCache.mapper || zoneTag !== drawCache.zoneTag) {
        drawCache.zoneTag = zoneTag;
        // Only warps the zone does not explain (old probe deaths stay on disk).
        const shown = pickShown(warplog.layerHits().filter(warplog.offModel), MAX_MARKS);
        drawMarks(mapper, shown);
        drawCache.stamp = stamp;
        drawCache.layer = layer;
        drawCache.mapper = mapper.key;
        const s = warplog.summary();
        const tag = layer ? 'CP on' : 'CP off';
        ui.title.setText_(`WARP MAP  ${tag}  ${s.warps}w ${s.probed}p${zoneTag}`);
    }

    const flare = deathwarp.finish();
    place(ui.respawnDot, deathwarp.respawn(), mapper);
    place(ui.finishDot, flare === null ? null : flare.position, mapper);
    place(ui.ballDot, ball.physicsPosition(), mapper);

    const showSplits = splits.state.showOnMap && splits.state.points.length > 0;
    const pts = showSplits ? splits.state.points : [];
    for (let i = 0; i < ui.splitMarks.length; i++) {
        const mark = ui.splitMarks[i];
        if (i >= pts.length) { mark.setHidden_(true); continue; }
        const p = mapper.toScreen(pts[i]);
        const half = pts[i].half > 0 ? pts[i].half : splits.HALF;
        const s = Math.max(10, half * 2 * mapper.scale);
        mark.setFrame_([[p.x - s / 2, p.y - s / 2], [s, s]]);
        mark.setHidden_(false);
    }
}

function setVisible(value) {
    if (ui.box !== null) ui.box.setHidden_(!value);
    try { warplog.noteMap(isVisible()); } catch (err) { /* */ }
}

function isVisible() {
    return ui.box !== null && !ui.box.isHidden();
}

module.exports = { build, refresh, setVisible, isVisible, ui, SIZE };
