// Always-on run readout: position, speed, run timer, frame counter, dt.

const theme = require('./theme');
const w = require('./widgets');
const ball = require('../game/ball');
const frame = require('../game/frame');
const input = require('../game/input');
const macro = require('../tas/macro');
const warplog = require('../tas/warplog');

let label = null;
let warpLabel = null;
let box = null;

const state = { showWarp: true };

function build(window) {
    box = w.view([[24, 24], [228, 124]], theme.background);
    label = w.label([[10, 6], [208, 88]], 'no level', {
        size: 12, mono: true, color: theme.accent, lines: 6 });
    box.addSubview_(label);

    // Live death-warp readout: how far the finish trigger sits from the line
    // the ball would be dragged along if it died right now.
    warpLabel = w.label([[10, 94], [208, 24]], '', {
        size: 11, mono: true, color: theme.textDim, lines: 2 });
    box.addSubview_(warpLabel);

    // Off until asked for, so a fresh install shows nothing but the TAS pill.
    box.setHidden_(true);

    window.addSubview_(box);
    w.makeDraggable(box, box);
}

function isVisible() { return box !== null && !box.isHidden(); }

function refresh() {
    if (label === null || box.isHidden()) return;

    const p = ball.position();
    if (p === null) {
        label.setText_('no level');
        warpLabel.setText_('');
        return;
    }

    const speed = ball.speed() || 0;
    const paused = frame.state.paused;
    const mode = input.modeLabel().slice(0, 3).toUpperCase();

    let right;
    if (macro.state.mode === 'recording') right = `REC ${macro.length()}`;
    else if (macro.state.mode === 'playing') right = `PLAY ${macro.state.cursor}`;
    else right = paused ? 'PAUSED' : `${frame.state.speed.toFixed(2)}x`;

    label.setText_(
        `X ${p.x.toFixed(2).padStart(9)}\n` +
        `Y ${p.y.toFixed(2).padStart(9)}\n` +
        `Z ${p.z.toFixed(2).padStart(9)}\n` +
        `spd ${speed.toFixed(2).padStart(7)}   t ${frame.runTimer().toFixed(2)}\n` +
        `f ${frame.state.frame}  ${mode}  ${right}`);

    if (!state.showWarp) { warpLabel.setText_(''); return; }

    const tree = warplog.treeHint();
    let arm;
    if (tree.voidArmed === null) {
        arm = tree.movables > 0 ? `${tree.movables} movable(s) - void one` : 'no movables';
    } else if (tree.voidSpent) {
        arm = `${tree.voidArmed.name} void spent`;
    } else {
        arm = `ARMED ${tree.voidArmed.name}`;
    }
    warpLabel.setText_(arm);
    warpLabel.setTextColor_(tree.voidArmed !== null && !tree.voidSpent ? theme.accent : theme.textDim);
}

function setVisible(value) {
    if (box !== null) box.setHidden_(!value);
}

module.exports = { build, refresh, setVisible, isVisible, state, box: () => box };
