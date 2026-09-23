// Floating TAS button that expands into a draggable tabbed panel.
//
// Tabs: SPEED, TIME, MOVE, INPUT, MACRO, WARP, LOG, SKIN, ACHIEVE, SETTINGS.

const theme = require('./theme');
const w = require('./widgets');
const frame = require('../game/frame');
const ball = require('../game/ball');
const input = require('../game/input');
const macro = require('../tas/macro');
const deathwarp = require('../tas/deathwarp');
const ads = require('../tas/ads');
const level = require('../game/level');
const dpad = require('./dpad');
const keyboard = require('./keyboard');
const minimap = require('./minimap');
const picker = require('./picker');
const hud = require('./hud');
const power = require('./power');
const timer = require('./timer');
const splits = require('../tas/splits');
const achievements = require('../tas/achievements');
const skins = require('../tas/skins');
const rewind = require('../tas/rewind');
const tabs = require('./tabs');

const log = require('../core/log');
const warplog = require('../tas/warplog');
const budget = require('../core/budget');

const TABS = tabs.ALL;

const ui = {
    launcher: null,
    panel: null,
    content: null,
    pages: {},
    activeTab: 'SPEED',
    status: null,
    speedLabel: null,
    pauseButton: null,
    macroPause: null,
    teleportFields: {},
    macroStatus: null,
    macroList: null,
    macroScroll: null,
    macroInner: null,
    macroName: null,
    macroResume: null,
    macroSmooth: null,
    macroContinuePause: null,
    macroShift: null,
    macroRevertIntro: null,
    macroFrame: null,
    warpStatus: null,
    warpDetail: null,
    movableButton: null,
    checkpointButton: null,
    autoVoidButton: null,
    mapButton: null,
    layerButton: null,
    dropLabel: null,
    dropSlider: null,
    warpStatusText: '',
    logView: null,
    logPause: null,
    logFollow: true,
    logStamp: -1,
    skinList: null,
    skinStamp: '',
    flagButton: null,
    achieveList: null,
    achieveStamp: '',
    modeLabel: null,
    magLabel: null,
    confirm: null,
};

// Small modal used for anything destructive.
function confirm(question, detail, onYes, options) {
    if (ui.confirm !== null) ui.confirm.removeFromSuperview();
    const opts = options || {};
    const yesLabel = opts.yesLabel || 'OK';
    const lines = opts.lines || 3;
    const width = opts.width || 300;
    const height = opts.height || (lines > 4 ? 220 : 158);
    const card = w.view([[(W - width) / 2, (H - height) / 2], [width, height]], theme.surface);

    card.addSubview_(w.label([[14, 14], [width - 28, 22]], question,
        { size: 15, center: true }));
    card.addSubview_(w.label([[14, 40], [width - 28, height - 110]], detail,
        { size: 11, color: theme.textDim, lines: lines, center: true }));

    const half = (width - 42) / 2;
    card.addSubview_(w.button([[14, height - 58], [half, theme.TOUCH]], 'Cancel', function () {
        card.removeFromSuperview();
        ui.confirm = null;
        if (typeof opts.onCancel === 'function') opts.onCancel();
    }, { size: 15 }));

    card.addSubview_(w.button([[28 + half, height - 58], [half, theme.TOUCH]], yesLabel, function () {
        card.removeFromSuperview();
        ui.confirm = null;
        onYes();
    }, { size: 15, background: opts.danger ? theme.danger : theme.accentDim }));

    ui.panel.addSubview_(card);
    ui.confirm = card;
}

const W = theme.panel.width;
const H = theme.panel.height;
const TITLE_H = 28;
const STATUS_H = 36;
const HEADER = TITLE_H + STATUS_H;
const TABBAR = 40;

function setStatus(text) {
    if (ui.status === null) return;
    ui.status.setText_(String(text == null ? '' : text));
}

function paintSmoothCam() {
    const on = !!macro.state.smoothCam;
    const title = `SMOOTH CAM: ${on ? 'ON' : 'OFF'}`;
    const color = on ? theme.accentDim : theme.surfaceAlt;
    if (ui.macroSmooth === null) return;
    ui.macroSmooth.setTitle_forState_(title, 0);
    ui.macroSmooth.setBackgroundColor_(color);
}

function toggleSmoothCam() {
    macro.state.smoothCam = !macro.state.smoothCam;
    if (!macro.state.smoothCam) {
        try { macro.resetVisual(); } catch (err) { /* */ }
    }
    paintSmoothCam();
    setStatus(macro.state.smoothCam
        ? 'smooth cam is view-only - recorded yaw still drives physics'
        : 'raw cam - playback shows the recorded snaps');
}

function paintContinuePause() {
    const on = !!macro.state.continuePauses;
    if (ui.macroContinuePause === null) return;
    ui.macroContinuePause.setTitle_forState_(
        `CONTINUE PAUSES: ${on ? 'ON' : 'OFF'}`, 0);
    ui.macroContinuePause.setBackgroundColor_(on ? theme.accentDim : theme.surfaceAlt);
}

function toggleContinuePause() {
    macro.state.continuePauses = !macro.state.continuePauses;
    paintContinuePause();
    setStatus(macro.state.continuePauses
        ? 'CONTINUE will pause when the take runs out'
        : 'CONTINUE keeps the game running at the end of the take');
}

function syncPauseButtons() {
    const paused = frame.state.paused;
    [ui.pauseButton, ui.macroPause].forEach(btn => {
        if (btn === null) return;
        btn.setTitle_forState_(paused ? 'RESUME' : 'PAUSE', 0);
        btn.setBackgroundColor_(paused ? theme.accentDim : theme.surfaceAlt);
    });
    syncShiftButtons();
}

function syncShiftButtons() {
    if (ui.macroShift !== null) {
        const on = macro.shifting();
        const d = macro.shiftDelta();
        ui.macroShift.setTitle_forState_(
            on ? `STOP SHIFT (${d > 0 ? '+' : ''}${d}f)` : 'SHIFT INTRO', 0);
        ui.macroShift.setBackgroundColor_(on ? theme.accentDim : theme.surfaceAlt);
    }
    if (ui.macroRevertIntro !== null) {
        ui.macroRevertIntro.setEnabled_(macro.canRevertIntro() && !macro.shifting());
    }
}

// --------------------------------------------------------------- SPEED tab

function buildSpeedTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;

    ui.speedLabel = w.label([[12, y], [width - 24, 20]], 'Speed  1.00x  (macro)', { size: 13, mono: true });
    page.addSubview_(ui.speedLabel);
    y += 24;

    function showSpeed(value) {
        ui.speedLabel.setText_(`Speed  ${value.toFixed(2)}x  (macro)`);
    }

    page.addSubview_(w.slider([[12, y], [width - 24, 30]], 0.05, 3.0, 1.0, function (s) {
        const value = s.value();
        frame.setSpeed(value);
        showSpeed(value);
    }));
    y += 38;

    const presets = [['0.1x', 0.1], ['0.25x', 0.25], ['0.5x', 0.5], ['1x', 1.0], ['2x', 2.0]];
    const pw = (width - 24 - 4 * 6) / presets.length;
    presets.forEach(([title, value], i) => {
        page.addSubview_(w.button([[12 + i * (pw + 6), y], [pw, 38]], title, function () {
            frame.setSpeed(value);
            showSpeed(value);
        }));
    });
    y += 46;

    ui.pauseButton = w.button([[12, y], [width - 24, theme.TOUCH]], 'PAUSE', function () {
        frame.togglePaused();
        syncPauseButtons();
    }, { size: 15 });
    page.addSubview_(ui.pauseButton);
    y += theme.TOUCH + 8;

    const note = w.label([[12, y], [width - 24, 52]],
        'Free play uses the game clock. 1/60 and this slider apply only while recording or playing a macro. Record at 0.5x, play at 1x: same run.',
        { size: 11, lines: 3, color: theme.textDim });
    note.setLineBreakMode_(0);
    page.addSubview_(note);

    return page;
}

// ---------------------------------------------------------------- TIME tab

function buildTimeTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;

    page.addSubview_(w.label([[12, y], [width - 24, 28]],
        'Level timer is the orange clock. N / NEXT SPLIT slides up, across, then '
        + 'down onto the next point. It stamps when you leave the box.',
        { size: 10, color: theme.textDim, lines: 2 }));
    y += 32;

    function toggle(title, isOn, setOn) {
        const button = w.button([[12, y], [width - 24, theme.TOUCH]],
            `${title}: ${isOn() ? 'ON' : 'OFF'}`, null,
            { size: 13, background: isOn() ? theme.accentDim : theme.surfaceAlt });
        w.register(button, 'tap', function () {
            const next = !isOn();
            setOn(next);
            button.setTitle_forState_(`${title}: ${next ? 'ON' : 'OFF'}`, 0);
            button.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
        });
        button.addTarget_action_forControlEvents_(
            w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
        page.addSubview_(button);
        y += theme.TOUCH + 4;
        return button;
    }

    toggle('Level timer', () => timer.isTimerVisible(), v => timer.setTimerVisible(v));
    toggle('Split overlay', () => timer.isSplitsVisible(), v => timer.setSplitsVisible(v));
    toggle('Segment timer', () => timer.isSegmentVisible(), v => timer.setSegmentVisible(v));
    toggle('Reset splits on death', () => splits.resetOnDeath(), v => splits.setResetOnDeath(v));
    y += 4;

    const half = (width - 30) / 2;
    page.addSubview_(w.button([[12, y], [half, theme.TOUCH]], 'PLACE POINT', function () {
        const p = splits.placePoint();
        setStatus(p === null ? 'no ball'
            : `point ${p.name} at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
    }, { size: 13 }));
    page.addSubview_(w.button([[18 + half, y], [half, theme.TOUCH]], 'DEL POINT', function () {
        setStatus(splits.removeLastPoint() ? 'removed last split point' : 'no points');
    }, { size: 13 }));
    y += theme.TOUCH + 8;

    page.addSubview_(w.button([[12, y], [half, 38]], 'NEXT SPLIT', function () {
        const r = splits.teleportToNext();
        setStatus(!r.ok ? r.reason
            : `sliding to ${r.point.name}  (stamps when you leave)`);
    }, { size: 13, background: theme.accentDim }));
    page.addSubview_(w.button([[18 + half, y], [half, 38]], 'RESET GOLD', function () {
        splits.clearGold();
        setStatus('gold and split times cleared');
    }, { size: 13, background: theme.surfaceAlt }));

    return page;
}

// ---------------------------------------------------------------- MOVE tab

function buildMoveTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;

    const fieldWidth = (width - 24 - 12) / 3;
    ['x', 'y', 'z'].forEach((axis, i) => {
        const tf = w.textField([[12 + i * (fieldWidth + 6), y], [fieldWidth, 38]],
            axis.toUpperCase());
        ui.teleportFields[axis] = tf;
        page.addSubview_(tf);
    });
    y += 42;

    // Plan view of the level; tap a spot and X/Z come back filled in. The panel
    // gets out of the way while picking and comes back either way.
    page.addSubview_(w.button([[12, y], [width - 24, 40]], 'SELECT COORDINATE ON MAP',
        function () {
            ui.panel.setHidden_(true);
            const opened = picker.open(function (chosen) {
                ui.panel.setHidden_(false);
                if (chosen === null) { setStatus('pick cancelled'); return; }

                ui.teleportFields.x.setText_(chosen.x.toFixed(3));
                ui.teleportFields.z.setText_(chosen.z.toFixed(3));
                const currentY = ui.teleportFields.y.text();
                if (currentY === null || currentY.toString().trim() === '') {
                    ui.teleportFields.y.setText_(chosen.y.toFixed(3));
                }
                setStatus('picked X and Z - set Y, then TELEPORT');
            });
            if (!opened) {
                ui.panel.setHidden_(false);
                setStatus('no level loaded');
            }
        }, { size: 13, background: theme.surfaceAlt }));
    y += 46;

    page.addSubview_(w.button([[12, y], [(width - 30) / 2, theme.TOUCH]], 'TELEPORT', function () {
        const values = ['x', 'y', 'z'].map(a => {
            const t = ui.teleportFields[a].text();
            return t === null ? NaN : parseFloat(t.toString());
        });
        if (values.some(isNaN)) { setStatus('fill in X, Y and Z'); return; }
        setStatus(ball.teleport(values[0], values[1], values[2])
            ? `kept tree, moved to ${values.map(v => v.toFixed(1)).join(', ')}`
            : 'no level loaded');
    }, { size: 15, background: theme.accentDim }));

    page.addSubview_(w.button([[18 + (width - 30) / 2, y], [(width - 30) / 2, theme.TOUCH]],
        'SLIDE TO', function () {
            const values = ['x', 'y', 'z'].map(a => {
                const t = ui.teleportFields[a].text();
                return t === null ? NaN : parseFloat(t.toString());
            });
            if (values.some(isNaN)) { setStatus('fill in X, Y and Z'); return; }
            setStatus(ball.slideTo(values[0], values[1], values[2])
                ? `sliding to ${values.map(v => v.toFixed(1)).join(', ')}`
                : 'no level loaded');
        }, { size: 14 }));
    y += theme.TOUCH + 8;

    page.addSubview_(w.button([[12, y], [width - 24, 40]],
        'COPY CURRENT', function () {
            const p = ball.physicsPosition();
            if (p === null) { setStatus('no level loaded'); return; }
            ui.teleportFields.x.setText_(p.x.toFixed(3));
            ui.teleportFields.y.setText_(p.y.toFixed(3));
            ui.teleportFields.z.setText_(p.z.toFixed(3));
            setStatus('copied current position');
        }, { size: 14 }));
    y += 48;

    page.addSubview_(w.label([[12, y], [width - 24, 16]], 'Nudge', { size: 11, color: theme.textDim }));
    y += 20;

    const nudges = [
        ['X-', -1, 0, 0], ['X+', 1, 0, 0],
        ['Y-', 0, -1, 0], ['Y+', 0, 1, 0],
        ['Z-', 0, 0, -1], ['Z+', 0, 0, 1],
    ];
    const nw = (width - 24 - 5 * 6) / 6;
    nudges.forEach(([title, dx, dy, dz], i) => {
        page.addSubview_(w.button([[12 + i * (nw + 6), y], [nw, 40]], title, function () {
            ball.nudge(dx, dy, dz);
        }, { size: 13 }));
    });
    y += 48;

    page.addSubview_(w.button([[12, y], [width - 24, 40]], 'STOP BALL',
        function () { setStatus(ball.stop() ? 'velocity zeroed' : 'no level loaded'); },
        { size: 14 }));

    return page;
}

// --------------------------------------------------------------- MACRO tab

function layoutMacroScroll() {
    if (ui.macroScroll === null || ui.macroInner === null || ui.macroList === null) return;
    const width = ui.macroInner.frame()[1][0];
    const list = ui.macroList.frame();
    const names = (function () {
        try { return macro.list().length; } catch (err) { return 0; }
    }());
    const rows = Math.max(1, Math.ceil(Math.max(names, 1) / 3));
    const listH = Math.max(160, 12 + rows * 40);
    ui.macroList.setFrame_([[list[0][0], list[0][1]], [list[1][0], listH]]);
    const total = list[0][1] + listH + 20;
    ui.macroInner.setFrame_([[0, 0], [width, total]]);
    ui.macroScroll.setContentSize_([width, total]);
}

function buildMacroTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    const scroll = w.scrollView([[0, 0], [width, height]], null, 0);
    const inner = w.view([[0, 0], [width, 1100]], null, 0);
    ui.macroScroll = scroll;
    ui.macroInner = inner;
    let y = 6;

    inner.addSubview_(w.label([[12, y], [width - 24, 96]],
        'RECORD = new take from a restart, including the intro (skip it yourself; that frame is part of the TAS). '
        + 'CONTINUE = replay this take from the start, then keep recording. PAUSE or -N during it leaves off right there. '
        + 'CONTINUE PAUSES freezes at the end so you can RESUME into the run. '
        + 'PLAY / PLAY CLEAN do not freeze the game. '
        + 'PAUSE during PLAY CLEAN stops the take and restores the UI. '
        + 'SMOOTH CAM is view-only and does not change the run.',
        { size: 10, color: theme.textDim, lines: 7 }));
    y += 100;

    ui.macroStatus = w.label([[12, y], [width - 24, 20]], 'no macro',
        { size: 13, mono: true, color: theme.accent });
    inner.addSubview_(ui.macroStatus);
    y += 24;

    const quarter = (width - 24 - 18) / 4;
    inner.addSubview_(w.button([[12, y], [quarter, theme.TOUCH]], 'RECORD', function () {
        const t = ui.macroName.text();
        const name = t === null ? '' : t.toString().trim();
        setStatus(macro.record({ name: name === '' ? null : name })
            ? 'restarting level, then recording'
            : (macro.state.lastError || 'cannot record'));
    }, { size: 14, background: theme.surfaceAlt }));

    inner.addSubview_(w.button([[18 + quarter, y], [quarter, theme.TOUCH]], 'PLAY', function () {
        setStatus(macro.play() ? 'restarting, then replaying'
            : (macro.state.lastError || 'nothing recorded'));
    }, { size: 14, background: theme.accentDim }));

    ui.macroResume = w.button([[24 + quarter * 2, y], [quarter, theme.TOUCH]], 'CONTINUE',
        function () {
            setStatus(macro.resume()
                ? 'playing this take from the start, then PAUSE at the end'
                : (macro.state.lastError || 'nothing to continue'));
            syncPauseButtons();
        }, { size: 12 });
    inner.addSubview_(ui.macroResume);

    inner.addSubview_(w.button([[30 + quarter * 3, y], [quarter, theme.TOUCH]], 'STOP', function () {
        macro.stop();
        timer.endClean();
        setStatus(`stopped at ${macro.length()} frames`);
    }, { size: 14 }));
    y += theme.TOUCH + 8;

    const seventh = (width - 24 - 36) / 7;
    ui.macroPause = w.button([[12, y], [seventh, theme.TOUCH]], 'PAUSE', function () {
        frame.togglePaused();
        if (frame.state.paused) {
            try { macro.persist('pause', true); } catch (err) { /* */ }
        }
        syncPauseButtons();
    }, { size: 11 });
    inner.addSubview_(ui.macroPause);
    [['-60', -60], ['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10], ['+60', 60]]
        .forEach(([title, delta], i) => {
            inner.addSubview_(w.button([[18 + seventh * (i + 1), y], [seventh, theme.TOUCH]],
                title, function () {
                    const ok = rewind.step(delta);
                    syncPauseButtons();
                    setStatus(ok
                        ? (delta < 0
                            ? (rewind.state.lastOp || `back ${-delta}`)
                            : `forward ${delta}`)
                        : (rewind.state.lastError || 'cannot step'));
                }, { size: 12 }));
        });
    y += theme.TOUCH + 6;

    ui.macroFrame = w.textField([[12, y], [width - 24 - 90, 38]], 'frame #');
    ui.macroFrame.setKeyboardType_(4);
    inner.addSubview_(ui.macroFrame);
    inner.addSubview_(w.button([[width - 90, y], [78, 38]], 'JUMP', function () {
        const t = ui.macroFrame.text();
        const n = parseInt(t === null ? '' : t.toString(), 10);
        if (!isFinite(n) || n < 0) {
            setStatus(`now ${macro.length()}f - type a frame number`);
            return;
        }
        const ok = rewind.jump(n);
        syncPauseButtons();
        setStatus(ok ? `jump ${n}` : (rewind.state.lastError || macro.state.lastError || 'jump failed'));
    }, { size: 13 }));
    y += 46;

    const cleanHalf = (width - 30) / 2;
    inner.addSubview_(w.button([[12, y], [cleanHalf, 38]], 'PLAY CLEAN', function () {
        ui.panel.setHidden_(true);
        setStatus(timer.playClean()
            ? 'clean replay - UI back after the finish screen'
            : (macro.state.lastError || 'nothing recorded'));
    }, { size: 13, background: theme.accentDim }));
    ui.macroSmooth = w.button([[18 + cleanHalf, y], [cleanHalf, 38]],
        `SMOOTH CAM: ${macro.state.smoothCam ? 'ON' : 'OFF'}`, function () {
            toggleSmoothCam();
        }, { size: 12, background: macro.state.smoothCam ? theme.accentDim : theme.surfaceAlt });
    inner.addSubview_(ui.macroSmooth);
    y += 46;

    ui.macroContinuePause = w.button([[12, y], [width - 24, 38]],
        `CONTINUE PAUSES: ${macro.state.continuePauses ? 'ON' : 'OFF'}`, function () {
            toggleContinuePause();
        }, { size: 13, background: macro.state.continuePauses ? theme.accentDim : theme.surfaceAlt });
    inner.addSubview_(ui.macroContinuePause);
    y += 46;

    inner.addSubview_(w.button([[12, y], [width - 24, 38]], 'REFRESH PHYSICS', function () {
        setStatus(macro.refresh()
            ? 'refreshing - replaying the take at high speed, pauses where you left off'
            : (macro.state.lastError || 'cannot refresh'));
        syncPauseButtons();
    }, { size: 13, background: theme.accentDim }));
    y += 42;
    inner.addSubview_(w.label([[12, y], [width - 24, 72]],
        'Rewind puts the ball back, but not the physics engine\'s memory of contacts and '
        + 'object order. After lots of rewinds, especially around crates and other movable '
        + 'objects, the take may not play back the way you saw it. REFRESH replays the take '
        + 'from the start at high speed (up to 8x) and pauses where you left off, so everything you record next '
        + 'plays back exactly. The console names the first frame that came out different; '
        + 'nothing is cut.',
        { size: 10, color: theme.textDim, lines: 7 }));
    y += 76;

    inner.addSubview_(w.label([[12, y], [width - 24, 72]],
        'SHIFT INTRO freezes the ball and moves only the platform cycle: +N runs it forward '
        + 'live, -N replays at high speed with an earlier start (back to intro frame 1). When you stop, '
        + 'the intro-skip tap moves by that many frames (every later input moves with it). '
        + 'Use this to retarget a platform cycle without '
        + 're-recording the run. Caveat: anything time-gated before the shift point will desync. '
        + 'REVERT INTRO restores the original skip timing.',
        { size: 10, color: theme.textDim, lines: 5 }));
    y += 76;

    const shiftHalf = (width - 30) / 2;
    ui.macroShift = w.button([[12, y], [shiftHalf, 38]], 'SHIFT INTRO', function () {
        if (macro.shifting()) {
            const pending = macro.shiftDelta();
            confirm('Stop shifting platforms?',
                pending === 0
                    ? 'No frames pending. Cancel leaves the take unchanged.'
                    : `This will alter the start time for your macro by ${pending > 0 ? '+' : ''}${pending} frames `
                        + `(intro skip moves ${pending > 0 ? 'later' : 'earlier'}; every later input moves with it). `
                        + 'Anything that depended on the old cycle before this point can break.',
                function () {
                    if (pending === 0) {
                        macro.cancelShift();
                        setStatus('shift cancelled');
                    } else if (macro.applyShift()) {
                        setStatus(`intro skip moved ${pending > 0 ? '+' : ''}${pending}f - PLAY to verify`);
                    } else {
                        setStatus(macro.state.lastError || 'apply failed');
                    }
                    syncShiftButtons();
                }, {
                    yesLabel: pending === 0 ? 'Done' : 'Alter start',
                    lines: 6,
                    height: 230,
                    onCancel: function () {
                        confirm('Abandon platform shift?',
                            'Drops the pending delay. The take is unchanged, but the live '
                            + 'platforms have moved - PLAY or restart to resync.',
                            function () {
                                macro.cancelShift();
                                setStatus('shift abandoned - PLAY to resync');
                                syncShiftButtons();
                            }, { yesLabel: 'Abandon', danger: true, lines: 4, height: 190 });
                    },
                });
            return;
        }
        confirm('Shift intro timing?',
            'Ball and camera stay put. +N runs platforms forward; -N replays with an earlier '
            + 'start (a few seconds at high speed). Nothing is saved yet. Stop when the cycle looks '
            + 'right, then confirm to move the intro-skip tap by that many frames.',
            function () {
                setStatus(macro.beginShift()
                    ? 'shifting - use +N until the platform lines up, then SHIFT INTRO again'
                    : (macro.state.lastError || 'cannot shift'));
                syncShiftButtons();
            }, { yesLabel: 'Begin', lines: 5, height: 210 });
    }, { size: 12, background: theme.surfaceAlt });
    inner.addSubview_(ui.macroShift);

    ui.macroRevertIntro = w.button([[18 + shiftHalf, y], [shiftHalf, 38]], 'REVERT INTRO',
        function () {
            if (!macro.canRevertIntro()) {
                setStatus('no shifted intro to revert (baseline is set on first Shift)');
                return;
            }
            confirm('Restore original intro timing?',
                'Puts the intro-skip tap back where it was before any Shift Intro edits '
                + 'in this session (or the loaded baseline).',
                function () {
                    setStatus(macro.revertIntroShift()
                        ? 'intro timing restored - PLAY to verify'
                        : (macro.state.lastError || 'revert failed'));
                    syncShiftButtons();
                }, { yesLabel: 'Restore', danger: true, lines: 4, height: 190 });
        }, { size: 12, background: theme.surfaceAlt });
    inner.addSubview_(ui.macroRevertIntro);
    y += 46;

    ui.macroName = w.textField([[12, y], [width - 24 - 12 - 160, 38]], 'macro name');
    ui.macroName.setKeyboardType_(0);
    inner.addSubview_(ui.macroName);

    const nameWidth = width - 24 - 12 - 160;
    inner.addSubview_(w.button([[18 + nameWidth, y], [77, 38]], 'SAVE', function () {
        const t = ui.macroName.text();
        const name = t === null ? '' : t.toString().trim();
        if (name === '') { setStatus('name the macro first'); return; }
        setStatus(macro.save(name)
            ? `saved ${name} for level ${macro.levelNumber()}`
            : 'save failed - nothing recorded?');
        refreshMacros();
    }, { size: 13 }));

    inner.addSubview_(w.button([[101 + nameWidth, y], [77, 38]], 'DELETE', function () {
        const t = ui.macroName.text();
        const name = t === null ? '' : t.toString().trim();
        if (name === '') { setStatus('name the macro first'); return; }
        confirm(`Delete "${name}"?`,
            `Moves the saved macro for level ${macro.levelNumber()} to aerox-tas/trash/.`,
            function () {
                setStatus(macro.remove(name) ? `deleted ${name}` : 'no such macro');
                refreshMacros();
            }, { yesLabel: 'Delete', danger: true });
    }, { size: 13, background: theme.surfaceAlt }));
    y += 46;

    inner.addSubview_(w.button([[12, y], [width - 24, 38]], 'RECOVER FROM TAPE', function () {
        confirm('Recover takes from tape.log?',
            'Rebuilds the newest runs in tape.log (recordings and replays) and saves them as '
            + '"tape NN ..." macros under their level. Nothing existing is changed. Inputs are '
            + 'rounded to 4 decimals, so CONTINUE a recovered take and fix any drift.',
            function () {
                let msg = 'recover failed';
                try { msg = require('../tas/recover').fromTape(); } catch (err) { msg = `recover: ${err.message}`; }
                setStatus(msg);
                refreshMacros();
            }, { yesLabel: 'Recover', lines: 5, height: 210 });
    }, { size: 13, background: theme.surfaceAlt }));
    y += 46;

    inner.addSubview_(w.label([[12, y], [width - 24, 16]],
        'Saved for this level - tap to load', { size: 11, color: theme.textDim }));
    y += 18;

    ui.macroList = w.view([[12, y], [width - 24, 160]], theme.surface, 8);
    inner.addSubview_(ui.macroList);
    scroll.addSubview_(inner);
    page.addSubview_(scroll);
    layoutMacroScroll();

    return page;
}

function refreshMacros() {
    if (ui.macroList === null) return;

    const existing = ui.macroList.subviews();
    for (let i = existing.count() - 1; i >= 0; i--) {
        existing.objectAtIndex_(i).removeFromSuperview();
    }

    const names = macro.list();
    const listWidth = ui.macroList.frame()[1][0];
    // A name left in the field from another level's macro would get reused by
    // RECORD / SAVE here. Clear it when the loaded take is not this level's.
    try {
        const t = ui.macroName.text();
        const typed = t === null ? '' : t.toString().trim();
        if (typed !== '' && typed === macro.state.loaded
            && macro.takeLevel() !== macro.levelNumber()) {
            ui.macroName.setText_('');
        }
    } catch (err) { /* */ }

    if (names.length === 0) {
        ui.macroList.addSubview_(w.label([[0, 8], [listWidth, 20]],
            `no macros for level ${macro.levelNumber()}`,
            { size: 11, color: theme.textDim, center: true }));
        layoutMacroScroll();
        return;
    }

    const cols = 3;
    const bw = (listWidth - 8 - (cols - 1) * 6) / cols;
    names.forEach((name, i) => {
        const x = 4 + (i % cols) * (bw + 6);
        const row = Math.floor(i / cols);
        const finished = macro.isComplete(name);
        ui.macroList.addSubview_(w.button([[x, 6 + row * 40], [bw, 34]],
            finished ? name : `${name} ...`, function () {
                setStatus(macro.load(name)
                    ? `loaded ${name}${finished ? '' : ' - CONTINUE to extend it'}`
                    : `could not load ${name}`);
                ui.macroName.setText_(name);
            }, { size: 11, background: finished ? theme.accentDim : theme.surfaceAlt }));
    });
    layoutMacroScroll();
}

// ---------------------------------------------------------------- WARP tab

function buildWarpTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    const scroll = w.scrollView([[0, 0], [width, height]], null, 0);
    const inner = w.view([[0, 0], [width, 720]], null, 0);
    let y = 6;

    ui.warpStatus = w.label([[12, y], [width - 24, 34]], 'no level',
        { size: 11, mono: true, color: theme.accent, lines: 2 });
    inner.addSubview_(ui.warpStatus);
    y += 38;

    const half = (width - 30) / 2;

    inner.addSubview_(w.button([[12, y], [half, 40]],
        'FORCE VOID', function () {
            const r = deathwarp.forceVoid();
            if (!r.ok) { setStatus(r.reason); return; }
            setStatus(`forced ${r.label} into the void`);
        }, { size: 12 }));

    ui.autoVoidButton = w.button([[18 + half, y], [half, 40]],
        'AUTO VOID: OFF', null, { size: 12 });
    w.register(ui.autoVoidButton, 'tap', function () {
        const on = deathwarp.setAutoVoid(!deathwarp.autoVoidOn());
        paintAuto();
        setStatus(on
            ? 'auto void on respawn and restart'
            : 'auto void off');
    });
    ui.autoVoidButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    inner.addSubview_(ui.autoVoidButton);
    y += 46;

    ui.checkpointButton = w.button([[12, y], [width - 24, 38]],
        'Checkpoint: OFF', null, { size: 12 });
    w.register(ui.checkpointButton, 'tap', function () {
        const on = deathwarp.setWantCheckpoint(!deathwarp.wantCheckpoint());
        paintCheckpoint();
        setStatus(on
            ? 'checkpoint stays on across resets'
            : 'spawn restored to the level start');
    });
    ui.checkpointButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    inner.addSubview_(ui.checkpointButton);

    y += 44;

    ui.mapButton = w.button([[12, y], [half, 38]],
        `Warp map: ${minimap.isVisible() ? 'ON' : 'OFF'}`, null, { size: 12 });
    w.register(ui.mapButton, 'tap', function () {
        minimap.setVisible(!minimap.isVisible());
        paintWarpView();
    });
    ui.mapButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    inner.addSubview_(ui.mapButton);

    ui.layerButton = w.button([[18 + half, y], [half, 38]],
        layerTitle(), null, { size: 11 });
    w.register(ui.layerButton, 'tap', function () {
        warplog.cycleMapLayer();
        paintWarpView();
    });
    ui.layerButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    inner.addSubview_(ui.layerButton);
    y += 44;

    ui.dropLabel = w.label([[12, y], [width - 24, 16]],
        `Object drop Y  ${deathwarp.objectDropY().toFixed(1)}`,
        { size: 11, mono: true, color: theme.accent });
    inner.addSubview_(ui.dropLabel);
    y += 18;
    ui.dropSlider = w.slider([[12, y], [width - 24, 26]], -24, 16,
        deathwarp.objectDropY(), function (s) {
            const yv = deathwarp.setObjectDropY(s.value());
            if (ui.dropLabel !== null) {
                ui.dropLabel.setText_(`Object drop Y  ${yv.toFixed(1)}`);
            }
        });
    inner.addSubview_(ui.dropSlider);
    y += 56;

    inner.setFrame_([[0, 0], [width, y]]);
    scroll.addSubview_(inner);
    scroll.setContentSize_([width, y]);
    scroll.setDelaysContentTouches_(false);
    page.addSubview_(scroll);
    return page;
}

function paintCheckpoint() {
    if (ui.checkpointButton === null) return;
    const on = deathwarp.wantCheckpoint();
    const has = deathwarp.hasCheckpoints();
    let title = `Checkpoint: ${on ? 'ON' : 'OFF'}`;
    if (on && !has) title = 'Checkpoint: ON (none on this level)';
    ui.checkpointButton.setTitle_forState_(title, 0);
    ui.checkpointButton.setBackgroundColor_(on && has ? theme.accentDim : theme.surfaceAlt);
}

function layerTitle() {
    const l = warplog.state.mapLayer;
    if (l === true) return 'Layer: CP ON';
    if (l === false) return 'Layer: CP OFF';
    return 'Layer: LIVE';
}

function paintWarpView() {
    if (ui.mapButton !== null) {
        const on = minimap.isVisible();
        ui.mapButton.setTitle_forState_(`Warp map: ${on ? 'ON' : 'OFF'}`, 0);
        ui.mapButton.setBackgroundColor_(on ? theme.accentDim : theme.surfaceAlt);
    }
    if (ui.layerButton !== null) {
        ui.layerButton.setTitle_forState_(layerTitle(), 0);
    }
}

function paintAuto() {
    if (ui.autoVoidButton !== null) {
        const on = deathwarp.autoVoidOn();
        const phase = deathwarp.autoVoidPhase();
        let title = 'AUTO VOID: OFF';
        if (on) {
            title = phase === 'idle' ? 'AUTO VOID: ON' : `VOID: ${phase}`;
        }
        ui.autoVoidButton.setTitle_forState_(title, 0);
        ui.autoVoidButton.setBackgroundColor_(on ? theme.accentDim : theme.surfaceAlt);
    }
}

function refreshWarp() {
    if (ui.warpStatus === null) return;
    paintCheckpoint();
    paintAuto();
    paintWarpView();
    if (ui.dropLabel !== null) {
        ui.dropLabel.setText_(`Object drop Y  ${deathwarp.objectDropY().toFixed(1)}`);
    }
    const text = deathwarp.describe();
    if (text !== ui.warpStatusText) {
        ui.warpStatusText = text;
        ui.warpStatus.setText_(text);
    }
}

// ----------------------------------------------------------------- LOG tab

function buildLogTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);

    page.addSubview_(w.label([[12, 6], [width - 24, 40]],
        'Last 80 lines here. Full log: Aerox Documents/aerox-tas/tas.log '
        + '(Filza). Survives a Frida cutoff or Process terminated. Caps at ~180KB.',
        { size: 10, color: theme.textDim, lines: 3 }));

    const bottom = height - theme.TOUCH - 12;
    ui.logView = w.label([[12, 36], [width - 24, bottom - 40]], '',
        { size: 9, mono: true, color: theme.textDim, lines: 40 });
    page.addSubview_(ui.logView);

    const half = (width - 30) / 2;
    page.addSubview_(w.button([[12, bottom], [half, theme.TOUCH]], 'CLEAR',
        function () { log.clear(); ui.logView.setText_(''); }, { size: 13 }));

    ui.logPause = w.button([[18 + half, bottom], [half, theme.TOUCH]],
        'Auto-scroll: ON', null, { size: 13, background: theme.accentDim });
    w.register(ui.logPause, 'tap', function () {
        ui.logFollow = !ui.logFollow;
        ui.logPause.setTitle_forState_(`Auto-scroll: ${ui.logFollow ? 'ON' : 'OFF'}`, 0);
        ui.logPause.setBackgroundColor_(ui.logFollow ? theme.accentDim : theme.surfaceAlt);
    });
    ui.logPause.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    page.addSubview_(ui.logPause);

    return page;
}

// ---------------------------------------------------------------- SKIN tab

function buildSkinTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;

    const half = (width - 30) / 2;
    page.addSubview_(w.button([[12, y], [half, 38]], 'STOCK BALL', function () {
        const r = skins.apply('stock');
        setStatus(r.ok ? 'stock ball' : r.reason);
        refreshSkin();
    }, { size: 13 }));

    ui.flagButton = w.button([[18 + half, y], [half, 38]],
        `Flag: ${skins.flagTitle()}`, function () {
            if (!achievements.skinUnlocked('flag')) {
                setStatus('flags are still locked');
                return;
            }
            const next = skins.cycleFlag();
            ui.flagButton.setTitle_forState_(`Flag: ${next.title}`, 0);
            setStatus(`flag ${next.title}`);
            refreshSkin();
        }, { size: 13 });
    page.addSubview_(ui.flagButton);
    y += 46;

    ui.skinList = w.scrollView([[12, y], [width - 24, height - y - 8]], theme.surface, 8);
    page.addSubview_(ui.skinList);
    refreshSkin();
    return page;
}

function refreshSkin() {
    if (ui.skinList === null) return;
    const items = achievements.list();
    const applied = skins.state.applied || 'stock';
    const stamp = items.map(i => `${i.id}:${i.unlocked ? 1 : 0}`).join('|')
        + `|${applied}|${skins.flagTitle()}`;
    if (stamp === ui.skinStamp) return;
    ui.skinStamp = stamp;

    if (ui.flagButton !== null) {
        ui.flagButton.setTitle_forState_(`Flag: ${skins.flagTitle()}`, 0);
        ui.flagButton.setBackgroundColor_(
            achievements.skinUnlocked('flag') ? theme.accentDim : theme.surfaceAlt);
    }

    const existing = ui.skinList.subviews();
    for (let i = existing.count() - 1; i >= 0; i--) {
        existing.objectAtIndex_(i).removeFromSuperview();
    }

    const listWidth = ui.skinList.frame()[1][0];
    const rowH = 80;
    items.forEach((item, i) => {
        const y = 8 + i * rowH;
        const row = w.view([[8, y], [listWidth - 16, rowH - 6]], theme.surfaceAlt, 8);
        const preview = ObjC.classes.UIImageView.alloc().initWithFrame_([[10, 14], [48, 48]]);
        preview.layer().setCornerRadius_(24);
        preview.setClipsToBounds_(true);
        preview.setContentMode_(2);
        preview.setBackgroundColor_(item.unlocked ? skins.swatch(item.skin) : theme.surface);
        if (item.unlocked) {
            try {
                const img = skins.previewImage(item.skin);
                if (img !== null) preview.setImage_(img);
            } catch (err) { /* swatch is enough */ }
        }
        row.addSubview_(preview);
        row.addSubview_(w.label([[68, 8], [listWidth - 168, 20]], item.title, {
            size: 14, color: item.unlocked ? theme.text : theme.textDim,
        }));
        row.addSubview_(w.label([[68, 30], [listWidth - 168, 36]], item.detail, {
            size: 11, color: theme.textDim, lines: 2,
        }));
        const using = item.unlocked && applied === item.skin;
        const btn = w.button([[listWidth - 92, 18], [68, 36]],
            item.unlocked ? (using ? 'ON' : 'USE') : '???',
            function () {
                if (!item.unlocked) {
                    setStatus('still locked');
                    return;
                }
                const r = skins.apply(item.skin);
                setStatus(r.ok ? (r.queued ? 'applying...' : item.title)
                    : r.reason === 'queued' ? 'applying...'
                    : (r.reason || skins.state.lastError || 'failed'));
                ui.skinStamp = '';
                refreshSkin();
            }, {
                size: 12,
                background: using ? theme.accentDim : theme.surface,
            });
        row.addSubview_(btn);
        ui.skinList.addSubview_(row);
    });
    ui.skinList.setContentSize_([listWidth, 12 + items.length * rowH]);
}

// ------------------------------------------------------------ ACHIEVE tab

function buildAchieveTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;
    page.addSubview_(w.label([[12, y], [width - 24, 32]],
        'TAS achievements. Locked rows stay a mystery. RESET clears unlocks on this device so you can test them again.',
        { size: 10, color: theme.textDim, lines: 2 }));
    y += 36;
    page.addSubview_(w.button([[12, y], [width - 24, 36]], 'RESET ACHIEVEMENTS', function () {
        confirm('Reset all TAS achievements?',
            'Skins lock again. Warp-level progress is cleared. This does not touch Game Center.',
            function () {
                achievements.resetAll();
                ui.achieveStamp = '';
                ui.skinStamp = '';
                refreshAchieve();
                refreshSkin();
                setStatus('achievements reset');
            }, { yesLabel: 'Reset', danger: true });
    }, { size: 13, background: theme.danger || theme.surfaceAlt }));
    y += 44;
    ui.achieveList = w.scrollView([[12, y], [width - 24, height - y - 8]], theme.surface, 8);
    page.addSubview_(ui.achieveList);
    refreshAchieve();
    return page;
}

function refreshAchieve() {
    if (ui.achieveList === null) return;
    const items = achievements.list();
    const stamp = items.map(i => `${i.id}:${i.unlocked ? 1 : 0}`).join('|');
    if (stamp === ui.achieveStamp) return;
    ui.achieveStamp = stamp;

    const existing = ui.achieveList.subviews();
    for (let i = existing.count() - 1; i >= 0; i--) {
        existing.objectAtIndex_(i).removeFromSuperview();
    }

    const listWidth = ui.achieveList.frame()[1][0];
    const rowH = 80;
    items.forEach((item, i) => {
        const y = 8 + i * rowH;
        const row = w.view([[8, y], [listWidth - 16, rowH - 6]], theme.surfaceAlt, 8);
        const preview = ObjC.classes.UIImageView.alloc().initWithFrame_([[10, 14], [48, 48]]);
        preview.layer().setCornerRadius_(24);
        preview.setClipsToBounds_(true);
        preview.setContentMode_(2);
        preview.setBackgroundColor_(item.unlocked ? skins.swatch(item.skin) : theme.surface);
        if (item.unlocked) {
            try {
                const img = skins.previewImage(item.skin);
                if (img !== null) preview.setImage_(img);
            } catch (err) { /* swatch is enough */ }
        }
        row.addSubview_(preview);
        row.addSubview_(w.label([[68, 8], [listWidth - 88, 20]], item.achieveTitle, {
            size: 14, color: theme.text,
        }));
        row.addSubview_(w.label([[68, 30], [listWidth - 88, 36]],
            item.unlocked ? `${item.ball}  -  ${item.detail}` : '???',
            { size: 11, color: theme.textDim, lines: 2 }));
        ui.achieveList.addSubview_(row);
    });
    ui.achieveList.setContentSize_([listWidth, 12 + items.length * rowH]);
}

// ------------------------------------------------------------ SETTINGS tab

function buildSettingsTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    const scroll = w.scrollView([[0, 0], [width, height]], null, 0);
    const innerW = width;
    const inner = w.view([[0, 0], [innerW, 1200]], null, 0);
    let y = 8;

    inner.addSubview_(w.label([[12, y], [width - 24, 18]], 'Visible tabs', {
        size: 13, color: theme.accent,
    }));
    y += 22;
    inner.addSubview_(w.label([[12, y], [width - 24, 28]],
        'Uncheck headers you do not need. SETTINGS stays on so you can get them back.',
        { size: 10, color: theme.textDim, lines: 2 }));
    y += 32;

    const colW = (width - 36) / 2;
    tabs.ALL.forEach((name, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const locked = name === 'SETTINGS';
        const on = tabs.isOn(name);
        const btn = w.button(
            [[12 + col * (colW + 12), y + row * 40], [colW, 36]],
            `${on ? '\u2611' : '\u2610'}  ${name}`,
            function () {
                if (locked) {
                    setStatus('SETTINGS stays visible');
                    return;
                }
                const next = tabs.setOn(name, !tabs.isOn(name));
                btn.setTitle_forState_(`${next ? '\u2611' : '\u2610'}  ${name}`, 0);
                btn.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
                layoutTabs();
            },
            { size: 12, background: on ? theme.accentDim : theme.surfaceAlt });
        inner.addSubview_(btn);
    });
    y += Math.ceil(tabs.ALL.length / 2) * 40 + 12;

    inner.addSubview_(w.label([[12, y], [width - 24, 18]], 'Game', {
        size: 13, color: theme.accent,
    }));
    y += 24;

    const adsButton = w.button([[12, y], [width - 24, theme.TOUCH]],
        `Block interstitial ads: ${ads.state.blocking ? 'ON' : 'OFF'}`, null,
        { size: 14, background: ads.state.blocking ? theme.accentDim : theme.surfaceAlt });
    w.register(adsButton, 'tap', function () {
        const next = !ads.state.blocking;
        ads.setBlocking(next);
        adsButton.setTitle_forState_(`Block interstitial ads: ${next ? 'ON' : 'OFF'}`, 0);
        adsButton.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
    });
    adsButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    inner.addSubview_(adsButton);
    y += theme.TOUCH + 4;

    inner.addSubview_(w.label([[12, y], [width - 24, 24]],
        'Answers the game\'s interstitial check with no, so an ad cannot land mid-run.',
        { size: 10, color: theme.textDim, lines: 2 }));
    y += 28;

    const hudButton = w.button([[12, y], [width - 24, 38]],
        `Coordinate readout: ${hud.isVisible() ? 'ON' : 'OFF'}`, null, { size: 13 });
    w.register(hudButton, 'tap', function () {
        const next = !hud.isVisible();
        hud.setVisible(next);
        hudButton.setTitle_forState_(`Coordinate readout: ${next ? 'ON' : 'OFF'}`, 0);
        hudButton.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
    });
    hudButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    hudButton.setBackgroundColor_(hud.isVisible() ? theme.accentDim : theme.surfaceAlt);
    inner.addSubview_(hudButton);
    y += 42;

    const brakeButton = w.button([[12, y], [width - 24, 38]],
        `Alt brake: ${input.altBrakeOn() ? 'ON' : 'OFF'}`, null, { size: 13 });
    w.register(brakeButton, 'tap', function () {
        const next = input.setAltBrake(!input.altBrakeOn());
        dpad.setBrakeVisible(next);
        brakeButton.setTitle_forState_(`Alt brake: ${next ? 'ON' : 'OFF'}`, 0);
        brakeButton.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
        setStatus(next
            ? 'alt brake on - hold BRAKE or B, or the in-game button'
            : 'alt brake off');
    });
    brakeButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    brakeButton.setBackgroundColor_(input.altBrakeOn() ? theme.accentDim : theme.surfaceAlt);
    inner.addSubview_(brakeButton);
    y += 42;

    inner.addSubview_(w.button([[12, y], [width - 24, 40]], 'RESTART LEVEL', function () {
        setStatus(level.inLevel() ? 'restarting level' : 'no level loaded');
        if (level.inLevel()) level.restart();
    }, { size: 14 }));
    y += 50;

    inner.addSubview_(w.label([[12, y], [width - 24, 18]], 'Memory', {
        size: 13, color: theme.accent,
    }));
    y += 22;
    inner.addSubview_(w.label([[12, y], [width - 24, 32]],
        'OFF drops that buffer. perf lines include free MB left before iOS kills the app.',
        { size: 10, color: theme.textDim, lines: 2 }));
    y += 36;

    const rewindBtn = w.button([[12, y], [width - 24, 38]],
        `Rewind snaps: ${budget.rewindOn() ? 'ON' : 'OFF'}`, null, { size: 13 });
    w.register(rewindBtn, 'tap', function () {
        const next = budget.setRewind(!budget.rewindOn());
        rewindBtn.setTitle_forState_(`Rewind snaps: ${next ? 'ON' : 'OFF'}`, 0);
        rewindBtn.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
        setStatus(next
            ? 'rewind snaps only while RECORD or PAUSE (not during PLAY/CONTINUE replay)'
            : 'rewind snaps off - history cleared');
    });
    rewindBtn.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    rewindBtn.setBackgroundColor_(budget.rewindOn() ? theme.accentDim : theme.surfaceAlt);
    inner.addSubview_(rewindBtn);
    y += 42;

    const warpMemBtn = w.button([[12, y], [width - 24, 38]],
        `Warp watch: ${budget.warpOn() ? 'ON' : 'OFF'}`, null, { size: 13 });
    w.register(warpMemBtn, 'tap', function () {
        const next = budget.setWarp(!budget.warpOn());
        warpMemBtn.setTitle_forState_(`Warp watch: ${next ? 'ON' : 'OFF'}`, 0);
        warpMemBtn.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
        setStatus(next
            ? 'warp watch follows the WARP tab, map, and AUTO'
            : 'warp watch off - scene walk and AUTO stopped');
    });
    warpMemBtn.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    warpMemBtn.setBackgroundColor_(budget.warpOn() ? theme.accentDim : theme.surfaceAlt);
    inner.addSubview_(warpMemBtn);
    y += 42;

    const skinMemBtn = w.button([[12, y], [width - 24, 38]],
        `Skin apply: ${budget.skinsOn() ? 'ON' : 'OFF'}`, null, { size: 13 });
    w.register(skinMemBtn, 'tap', function () {
        const next = budget.setSkins(!budget.skinsOn());
        skinMemBtn.setTitle_forState_(`Skin apply: ${next ? 'ON' : 'OFF'}`, 0);
        skinMemBtn.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
        setStatus(next ? 'skin apply on' : 'skin apply off - ball restored');
    });
    skinMemBtn.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    skinMemBtn.setBackgroundColor_(budget.skinsOn() ? theme.accentDim : theme.surfaceAlt);
    inner.addSubview_(skinMemBtn);
    y += 42;

    inner.addSubview_(w.button([[12, y], [width - 24, 40]], 'OPEN INSTRUCTIONS', function () {
        const url = require('../core/docs').instructionsUrl;
        try {
            const ns = ObjC.classes.NSURL.URLWithString_(url);
            const app = ObjC.classes.UIApplication.sharedApplication();
            const sel = 'openURL:options:completionHandler:';
            if (app.respondsToSelector_(ObjC.selector(sel))) {
                app.openURL_options_completionHandler_(ns, {}, null);
            } else {
                app.openURL_(ns);
            }
            setStatus('opening instructions in Safari');
        } catch (err) {
            setStatus('could not open URL - set src/core/docs.js to your GitHub link');
        }
    }, { size: 14, background: theme.accentDim }));
    y += 48;

    inner.addSubview_(w.label([[12, y], [width - 24, 44]],
        'Closing AeroMod restores the frame loop, input, ad gate, score ' +
        'saves, and the original ball. Completions do not write a menu best ' +
        'or Game Center while open.',
        { size: 10, color: theme.textDim, lines: 3 }));
    y += 48;

    inner.addSubview_(w.button([[12, y], [width - 24, theme.TOUCH]], 'CLOSE AEROMOD', function () {
        ui.panel.setHidden_(true);
        timer.endClean();
        power.disable(w.keyWindow());
    }, { size: 16, background: theme.danger }));
    y += theme.TOUCH + 16;

    inner.setFrame_([[0, 0], [innerW, y]]);
    scroll.addSubview_(inner);
    scroll.setContentSize_([innerW, y]);
    page.addSubview_(scroll);
    return page;
}

// --------------------------------------------------------------- INPUT tab

function buildInputTab(width, height) {
    const page = w.view([[0, 0], [width, height]], null, 0);
    let y = 6;

    page.addSubview_(w.label([[12, y], [width - 24, 30]],
        'Replaces tilt with the arrow pad so the iPad can lie flat.',
        { size: 11, color: theme.textDim, lines: 2 }));
    y += 32;

    const padButton = w.button([[12, y], [width - 24, theme.TOUCH]],
        'Virtual tilt: OFF', null, { size: 15 });
    w.register(padButton, 'tap', function () {
        const next = !input.state.enabled;
        input.setEnabled(next);
        dpad.setVisible(next);
        padButton.setTitle_forState_(next ? 'Virtual tilt: ON' : 'Virtual tilt: OFF', 0);
        padButton.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
    });
    padButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    page.addSubview_(padButton);
    y += theme.TOUCH + 8;

    const keyButton = w.button([[12, y], [width - 24, 40]],
        'Hardware keyboard: OFF', null, { size: 13 });
    w.register(keyButton, 'tap', function () {
        const next = !keyboard.state.enabled;
        keyboard.setEnabled(next);
        keyButton.setTitle_forState_(
            next ? 'Hardware keyboard: ON  (arrows, space, . , N, B, 1-4)'
                 : 'Hardware keyboard: OFF', 0);
        keyButton.setBackgroundColor_(next ? theme.accentDim : theme.surfaceAlt);
    });
    keyButton.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    page.addSubview_(keyButton);
    y += 48;

    // The control scheme decides how far the pad is allowed to push: Original
    // feeds on gravity and tops out at 1.0, Alternate reads CoreMotion Euler
    // angles and reaches pi. Both are read live from the game's own setting.
    ui.modeLabel = w.label([[12, y], [width - 24, 18]], 'Controls: -',
        { size: 12, mono: true, color: theme.accent });
    page.addSubview_(ui.modeLabel);
    y += 20;

    ui.magLabel = w.label([[12, y], [width - 24, 18]], 'Tilt magnitude  100%',
        { size: 12, mono: true });
    page.addSubview_(ui.magLabel);
    y += 20;

    page.addSubview_(w.slider([[12, y], [width - 24, 30]], 0.05, 1.0,
        input.state.magnitude, function (s) {
            input.state.magnitude = s.value();
            refreshInput();
            input.publishNative();
        }));
    y += 36;

    const invertSteer = w.button([[12, y], [(width - 30) / 2, 38]],
        `Invert steer: ${input.state.invertSteer ? 'ON' : 'OFF'}`, null, { size: 12 });
    w.register(invertSteer, 'tap', function () {
        input.state.invertSteer = !input.state.invertSteer;
        invertSteer.setTitle_forState_(
            `Invert steer: ${input.state.invertSteer ? 'ON' : 'OFF'}`, 0);
        input.publishNative();
    });
    invertSteer.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    page.addSubview_(invertSteer);

    const invertThrust = w.button([[18 + (width - 30) / 2, y], [(width - 30) / 2, 38]],
        `Invert thrust: ${input.state.invertThrust ? 'ON' : 'OFF'}`, null, { size: 12 });
    w.register(invertThrust, 'tap', function () {
        input.state.invertThrust = !input.state.invertThrust;
        invertThrust.setTitle_forState_(
            `Invert thrust: ${input.state.invertThrust ? 'ON' : 'OFF'}`, 0);
        input.publishNative();
    });
    invertThrust.addTarget_action_forControlEvents_(
        w.ensureTarget(), ObjC.selector('onTap:'), w.EVENT.touchUpInside);
    page.addSubview_(invertThrust);

    return page;
}

function refreshInput() {
    if (ui.modeLabel === null) return;
    const cap = input.cap();
    ui.modeLabel.setText_(
        `Controls: ${input.modeLabel()}   tilt cap ${cap.toFixed(2)}   ` +
        `speed cap ${input.speedCap().toFixed(1)}`);
    ui.magLabel.setText_(
        `Tilt magnitude  ${Math.round(input.state.magnitude * 100)}%` +
        `  (${(input.state.magnitude * cap).toFixed(2)})`);
}

// ------------------------------------------------------------------ shell

function layoutTabs() {
    const vis = tabs.visible();
    const tabWidth = vis.length > 0 ? W / vis.length : W;
    let i = 0;
    TABS.forEach(name => {
        const page = ui.pages[name];
        if (page === undefined) return;
        const on = tabs.isOn(name);
        page.button.setHidden_(!on);
        if (on) {
            page.button.setFrame_([[i * tabWidth, HEADER], [tabWidth, TABBAR]]);
            i += 1;
        }
    });
    if (!tabs.isOn(ui.activeTab)) selectTab(vis[0] || 'SETTINGS');
}

function selectTab(name) {
    ui.activeTab = name;
    TABS.forEach(tab => {
        const page = ui.pages[tab];
        if (page !== undefined) page.view.setHidden_(tab !== name);
        if (page !== undefined) {
            page.button.setBackgroundColor_(tab === name ? theme.accentDim : theme.surface);
        }
    });
    if (name === 'MACRO') refreshMacros();
    if (name === 'INPUT') refreshInput();
    if (name === 'WARP') refreshWarp();
    if (name === 'SKIN') refreshSkin();
    if (name === 'ACHIEVE') refreshAchieve();
    try { warplog.noteTab(name === 'WARP'); } catch (err) { /* */ }
}

// Driven from the UI timer, not the game loop, so it keeps ticking while paused.
function refresh() {
    if (ui.panel === null || ui.panel.isHidden()) return;
    if (ui.activeTab === 'MACRO' && ui.macroStatus !== null) {
        ui.macroStatus.setText_(macro.describe());
        syncPauseButtons();
    } else if (ui.activeTab === 'SPEED') {
        syncPauseButtons();
    } else if (ui.activeTab === 'WARP') {
        refreshWarp();
    } else if (ui.activeTab === 'INPUT') {
        refreshInput();
    } else if (ui.activeTab === 'SKIN') {
        refreshSkin();
    } else if (ui.activeTab === 'ACHIEVE') {
        refreshAchieve();
    } else if (ui.activeTab === 'LOG' && ui.logView !== null) {
        // Only re-marshal the text when something has actually been logged.
        if (ui.logFollow && ui.logStamp !== log.state.counter) {
            ui.logStamp = log.state.counter;
            ui.logView.setText_(log.text(38));
        }
    }
}

function build() {
    const window = w.keyWindow();
    if (window === null) { console.log('[aerox-tas] no key window'); return; }

    dpad.build(window);
    keyboard.build(window);

    // Launcher pill. The grip strip on the left is what you drag - a UIButton
    // consumes its own touches, so the pan gesture needs bare view to land on.
    ui.launcher = w.view([[24, 120], [156, theme.TOUCH]], theme.background);

    const grip = w.view([[0, 0], [30, theme.TOUCH]], theme.surface, 0);
    grip.addSubview_(w.label([[0, 0], [30, theme.TOUCH]], '\u22EE',
        { size: 16, color: theme.textDim, center: true }));
    ui.launcher.addSubview_(grip);
    w.makeDraggable(grip, ui.launcher);

    ui.launcher.addSubview_(w.button([[30, 0], [126, theme.TOUCH]], 'AeroMod', function () {
        const hidden = ui.panel.isHidden();
        ui.panel.setHidden_(!hidden);
    }, { size: 16, background: ObjC.classes.UIColor.clearColor(), color: theme.accent, corner: 0 }));

    window.addSubview_(ui.launcher);

    // Panel
    ui.panel = w.view([[24, 176], [W, H]], theme.background);

    const header = w.view([[0, 0], [W, HEADER]], theme.surface, 0);
    header.addSubview_(w.label([[12, 0], [96, TITLE_H]], 'AeroMod', { size: 13 }));
    header.addSubview_(w.button([[W - 44, 2], [38, 24]], '\u2715',
        () => ui.panel.setHidden_(true), { size: 14, background: theme.surfaceAlt }));
    ui.status = w.label([[12, TITLE_H - 2], [W - 24, STATUS_H]], 'ready',
        { size: 10, mono: true, color: theme.textDim, lines: 2 });
    ui.status.setTextAlignment_(0);
    try { ui.status.setLineBreakMode_(0); } catch (err) { /* */ }
    header.addSubview_(ui.status);
    ui.panel.addSubview_(header);
    w.makeDraggable(header, ui.panel);

    // Tab bar
    const tabWidth = W / TABS.length;
    const contentHeight = H - HEADER - TABBAR;
    ui.content = w.view([[0, HEADER + TABBAR], [W, contentHeight]], null, 0);

    TABS.forEach((name, i) => {
        const button = w.button([[i * tabWidth, HEADER], [tabWidth, TABBAR]], name,
            () => selectTab(name), { size: 8, corner: 0, background: theme.surface });
        ui.panel.addSubview_(button);

        const builder = {
            SPEED: buildSpeedTab, TIME: buildTimeTab,
            MOVE: buildMoveTab, INPUT: buildInputTab, MACRO: buildMacroTab,
            WARP: buildWarpTab, LOG: buildLogTab, SKIN: buildSkinTab,
            ACHIEVE: buildAchieveTab, SETTINGS: buildSettingsTab,
        }[name];
        const view = builder(W, contentHeight);
        view.setHidden_(true);
        ui.content.addSubview_(view);
        ui.pages[name] = { view, button };
    });

    ui.panel.addSubview_(ui.content);
    ui.panel.setHidden_(true);
    window.addSubview_(ui.panel);
    timer.attachPanel(ui.launcher, ui.panel);

    // Everything the tool owns, so closing the TAS can clear the screen.
    power.register(ui.launcher, { restore: true });
    power.register(ui.panel);

    layoutTabs();
    selectTab(tabs.isOn('SPEED') ? 'SPEED' : 'SETTINGS');
}

module.exports = { build, setStatus, refresh, refreshMacros, ui };
