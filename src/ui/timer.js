// On-screen run timer, split list, TAS watermark, and clean-play chrome.
//
// The coordinate HUD is a separate box. This is the one you actually want in
// a recording: a large orange clock at the top, optional split rows under it,
// and a tiny TAS mark so a clean macro replay is still obviously a TAS run.

const theme = require('./theme');
const w = require('./widgets');
const splits = require('../tas/splits');
const macro = require('../tas/macro');
const level = require('../game/level');
const hud = require('./hud');
const minimap = require('./minimap');
const dpad = require('./dpad');
const picker = require('./picker');
const frame = require('../game/frame');

const ORANGE = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.55, 0.12, 1);
const GREEN = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.25, 0.85, 0.40, 1);
const RED = () => ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.95, 0.32, 0.32, 1);
const WATERMARK = 'AeroMod';

const ui = {
    timer: null,
    clock: null,
    segment: null,
    splitBox: null,
    splitRows: [],
    mark: null,
    screenWidth: 0,
};

const chrome = {
    showTimer: false,
    showSplits: false,
    showSegment: false,
    clean: false,
    snapshot: null,
    restoreAt: 0,
    panel: null,
    launcher: null,
};

function attachPanel(launcher, panel) {
    chrome.launcher = launcher;
    chrome.panel = panel;
}

function layoutTimer() {
    if (ui.timer === null) return;
    const width = ui.screenWidth || 220;
    const both = chrome.showTimer && chrome.showSegment;
    ui.timer.setFrame_([[(width - 220) / 2, 10], [220, both ? 68 : 44]]);
    if (ui.clock !== null) {
        ui.clock.setFrame_([[0, 0], [220, both ? 40 : 44]]);
        ui.clock.setHidden_(!chrome.showTimer);
    }
    if (ui.segment !== null) {
        ui.segment.setFrame_([[0, both ? 40 : 8], [220, 24]]);
        ui.segment.setHidden_(!chrome.showSegment);
    }
}

function build(window) {
    const bounds = window.bounds();
    const width = bounds[1][0];
    ui.screenWidth = width;

    ui.timer = w.view([[(width - 220) / 2, 10], [220, 44]], null, 0);
    ui.timer.setUserInteractionEnabled_(false);
    ui.timer.setHidden_(true);
    ui.clock = w.label([[0, 0], [220, 44]], '0.00', {
        size: 32, mono: true, color: ORANGE(), center: true,
    });
    ui.clock.setFont_(ObjC.classes.UIFont.monospacedDigitSystemFontOfSize_weight_(32, 0.3));
    ui.timer.addSubview_(ui.clock);
    ui.segment = w.label([[0, 40], [220, 24]], '0.00', {
        size: 18, mono: true, color: ORANGE(), center: true,
    });
    ui.segment.setFont_(ObjC.classes.UIFont.monospacedDigitSystemFontOfSize_weight_(18, 0.3));
    ui.segment.setHidden_(true);
    ui.timer.addSubview_(ui.segment);
    window.addSubview_(ui.timer);

    ui.splitBox = w.view([[(width - 280) / 2, 82], [280, 196]],
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.05, 0.05, 0.07, 0.72), 8);
    ui.splitBox.setUserInteractionEnabled_(true);
    ui.splitBox.setHidden_(true);
    const grip = w.view([[0, 0], [280, 18]],
        ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.12, 0.13, 0.16, 0.9), 0);
    grip.addSubview_(w.label([[0, 0], [280, 18]], 'SPLITS', {
        size: 10, color: theme.textDim, center: true,
    }));
    ui.splitBox.addSubview_(grip);
    w.makeDraggable(grip, ui.splitBox);
    ui.splitRows = [];
    for (let i = 0; i < 8; i++) {
        const row = w.label([[10, 22 + i * 21], [260, 20]], '', {
            size: 13, mono: true, color: theme.text,
        });
        row.setUserInteractionEnabled_(false);
        ui.splitBox.addSubview_(row);
        ui.splitRows.push(row);
    }
    window.addSubview_(ui.splitBox);

    ui.mark = w.label([[width - 88, bounds[1][1] - 28], [80, 18]], WATERMARK, {
        size: 11, color: ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1, 1, 1, 0.45),
        center: true,
    });
    ui.mark.setUserInteractionEnabled_(false);
    ui.mark.setHidden_(true);
    window.addSubview_(ui.mark);
}

function setTimerVisible(value) {
    chrome.showTimer = !!value;
    if (ui.timer !== null && !chrome.clean) ui.timer.setHidden_(!chrome.showTimer);
}

function setSegmentVisible(value) {
    chrome.showSegment = !!value;
    layoutTimer();
}

function setSplitsVisible(value) {
    chrome.showSplits = !!value;
    splits.setShowOnMap(chrome.showSplits);
    if (ui.splitBox !== null && !chrome.clean) ui.splitBox.setHidden_(!chrome.showSplits);
}

function isTimerVisible() { return chrome.showTimer; }
function isSplitsVisible() { return chrome.showSplits; }
function isSegmentVisible() { return chrome.showSegment; }

function hideView(view) {
    if (view === null || view === undefined) return { view: null, hidden: true };
    let hidden = true;
    try { hidden = !!view.isHidden(); } catch (err) { return { view: null, hidden: true }; }
    try { view.setHidden_(true); } catch (err) { /* */ }
    return { view, hidden };
}

function restoreView(entry) {
    if (entry === null || entry.view === null) return;
    try { entry.view.setHidden_(entry.hidden); } catch (err) { /* */ }
}

function snapshotChrome() {
    const pickerRoot = picker.ui === undefined ? null : picker.ui.root;
    return {
        launcher: hideView(chrome.launcher),
        panel: hideView(chrome.panel),
        hud: hideView(hud.box()),
        map: hideView(minimap.ui.box),
        pad: hideView(dpad.box()),
        brake: hideView(dpad.brakeBox()),
        picker: hideView(pickerRoot),
        timer: hideView(ui.timer),
        splits: hideView(ui.splitBox),
        showTimer: chrome.showTimer,
        showSplits: chrome.showSplits,
    };
}

function beginClean() {
    if (chrome.clean) return;
    chrome.snapshot = snapshotChrome();
    chrome.clean = true;
    chrome.restoreAt = 0;
    if (ui.mark !== null) ui.mark.setHidden_(false);
    if (chrome.showTimer && ui.timer !== null) ui.timer.setHidden_(false);
    if (chrome.showSplits && ui.splitBox !== null) ui.splitBox.setHidden_(false);
}

function endClean() {
    chrome.restoreAt = 0;
    if (!chrome.clean) return;
    const snap = chrome.snapshot;
    chrome.clean = false;
    chrome.snapshot = null;
    if (ui.mark !== null) ui.mark.setHidden_(true);
    if (snap === null) return;
    restoreView(snap.launcher);
    restoreView(snap.panel);
    restoreView(snap.hud);
    restoreView(snap.map);
    restoreView(snap.pad);
    restoreView(snap.brake);
    restoreView(snap.picker);
    if (ui.timer !== null) ui.timer.setHidden_(!snap.showTimer);
    if (ui.splitBox !== null) ui.splitBox.setHidden_(!snap.showSplits);
}

function playClean() {
    beginClean();
    const ok = macro.play({ clean: true });
    if (!ok) {
        endClean();
        return false;
    }
    return true;
}

function paintSplits() {
    const rows = splits.rows();
    const labels = ui.splitRows;
    if (labels.length === 0) return;
    if (rows.length === 0) {
        const n = splits.state.points.length;
        labels[0].setText_(n === 0 ? 'no splits this run'
            : `${n} point(s) placed - waiting`);
        labels[0].setTextColor_(theme.textDim);
        for (let i = 1; i < labels.length; i++) labels[i].setText_('');
        return;
    }
    for (let i = 0; i < labels.length; i++) {
        if (i >= rows.length) {
            labels[i].setText_('');
            continue;
        }
        const r = rows[i];
        const useSeg = chrome.showSegment && r.segment !== null;
        const primary = useSeg ? r.segment : r.time;
        const d = useSeg ? r.segmentDelta : r.delta;
        const delta = d === null ? '' : `  ${splits.fmtDelta(d)}`;
        labels[i].setText_(
            `${r.name.padEnd(10)} ${splits.fmtTime(primary).padStart(7)}${delta}`);
        const ahead = d !== null && d < -0.005;
        const behind = d !== null && d > 0.005;
        labels[i].setTextColor_(ahead ? GREEN() : behind ? RED() : theme.text);
    }
}

function refresh() {
    if (!frame.state.installed) return;

    // CLEAN PLAY hides TAS buttons. The in-game pause (and space) must still
    // quit the take even if processGameFrame has already stopped.
    if (chrome.clean) {
        const mode = macro.state.mode;
        if (mode === 'playing' || mode === 'lingering' || mode === 'arming') {
            let gamePause = false;
            try { gamePause = level.pausedInGame(); } catch (err) { gamePause = false; }
            if (frame.state.paused || gamePause) {
                try { macro.abortPlayback('PLAY stopped - pause'); } catch (err) { /* */ }
                try { level.dismissPauseMenu(); } catch (err) { /* */ }
            }
        }
    }

    if (chrome.clean && chrome.restoreAt === 0
        && macro.state.mode === 'idle'
        && macro.state.lingerUntil === 0
        && macro.state.mode !== 'lingering') {
        chrome.restoreAt = Date.now() + 200;
    }
    if (chrome.clean && chrome.restoreAt > 0 && Date.now() >= chrome.restoreAt) {
        endClean();
    }

    const inLevel = level.inLevel();
    const complete = level.complete();
    const frozen = splits.state.frozen;
    if (ui.timer !== null) {
        const hide = (!chrome.showTimer && !chrome.showSegment)
            || (!inLevel && !complete && !frozen);
        ui.timer.setHidden_(hide);
        if (!hide) {
            const t = frozen && splits.state.run !== null
                ? splits.state.run.time : level.runTimer();
            if (chrome.showTimer) ui.clock.setText_(splits.fmtTime(t));
            if (ui.segment !== null && chrome.showSegment) {
                ui.segment.setText_(splits.fmtTime(splits.segmentTime()));
            }
        }
    }

    if (ui.splitBox !== null) {
        const keep = chrome.showSplits && (
            frozen || complete
            || (inLevel && (splits.rows().length > 0 || splits.state.points.length > 0))
        );
        ui.splitBox.setHidden_(!keep);
        if (keep) paintSplits();
    }

    if (ui.mark !== null) ui.mark.setHidden_(!chrome.clean);
}

function powerOff() {
    chrome.clean = false;
    chrome.snapshot = null;
    chrome.restoreAt = 0;
    if (ui.timer !== null) ui.timer.setHidden_(true);
    if (ui.splitBox !== null) ui.splitBox.setHidden_(true);
    if (ui.mark !== null) ui.mark.setHidden_(true);
}

module.exports = {
    build, refresh, attachPanel, powerOff,
    setTimerVisible, setSplitsVisible, setSegmentVisible,
    isTimerVisible, isSplitsVisible, isSegmentVisible,
    beginClean, endClean, playClean, chrome, ui,
};
