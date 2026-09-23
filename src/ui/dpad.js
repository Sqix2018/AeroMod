// Floating arrow pad that replaces tilt.
//
// This is the piece that makes the rest of the TAS workflow usable: with tilt
// controls the iPad is constantly moving, so hitting small buttons is a fight.
// Driving the game from a D-pad lets the device lie flat and the screen stay
// still, which is the only way precise frame-stepping is practical.

const theme = require('./theme');
const w = require('./widgets');
const input = require('../game/input');

const SIZE = 56;
const PAD = 200;
const HANDLE = 26;

let container = null;
let readout = null;
let brakeBox = null;

function arrow(frame, glyph, direction) {
    return w.holdButton(frame, glyph,
        () => input.hold(direction, true),
        () => input.hold(direction, false),
        { size: 24, background: theme.surfaceAlt, corner: 10 });
}

function build(window) {
    container = w.view([[40, 300], [PAD, PAD + HANDLE + 44]], theme.background);

    const handle = w.view([[0, 0], [PAD, HANDLE]], theme.surface, 0);
    const handleLabel = w.label([[0, 0], [PAD, HANDLE]], 'TILT PAD', {
        size: 11, color: theme.textDim, center: true });
    handle.addSubview_(handleLabel);
    container.addSubview_(handle);
    w.makeDraggable(handle, container);

    const top = HANDLE + 4;
    const mid = (PAD - SIZE) / 2;

    container.addSubview_(arrow([[mid, top], [SIZE, SIZE]], '\u25B2', 'up'));
    container.addSubview_(arrow([[8, top + SIZE + 4], [SIZE, SIZE]], '\u25C0', 'left'));
    container.addSubview_(arrow([[PAD - SIZE - 8, top + SIZE + 4], [SIZE, SIZE]], '\u25B6', 'right'));
    container.addSubview_(arrow([[mid, top + (SIZE + 4) * 2], [SIZE, SIZE]], '\u25BC', 'down'));

    readout = w.label([[mid - 8, top + SIZE + 4], [SIZE + 16, SIZE]], '0.00\n0.00', {
        size: 11, mono: true, color: theme.accent, center: true, lines: 2 });
    container.addSubview_(readout);

    const buttonsY = top + (SIZE + 4) * 3 + 4;
    container.addSubview_(w.holdButton([[8, buttonsY], [90, 38]], 'BTN A',
        () => input.setButton('a', true), () => input.setButton('a', false),
        { size: 13 }));
    container.addSubview_(w.holdButton([[PAD - 98, buttonsY], [90, 38]], 'BTN B',
        () => input.setButton('b', true), () => input.setButton('b', false),
        { size: 13 }));

    container.setHidden_(true);
    window.addSubview_(container);

    brakeBox = w.view([[40, 520], [132, 72]], theme.background);
    const grip = w.view([[0, 0], [132, 20]], theme.surface, 0);
    grip.addSubview_(w.label([[0, 0], [132, 20]], 'BRAKE', {
        size: 10, color: theme.textDim, center: true,
    }));
    brakeBox.addSubview_(grip);
    w.makeDraggable(grip, brakeBox);
    brakeBox.addSubview_(w.holdButton([[8, 24], [116, 40]], 'HOLD',
        () => input.setBrake(true),
        () => input.setBrake(false),
        { size: 15, background: theme.danger }));
    brakeBox.setHidden_(true);
    window.addSubview_(brakeBox);
}

function setVisible(value) {
    if (container !== null) container.setHidden_(!value);
}

function setBrakeVisible(value) {
    if (brakeBox !== null) brakeBox.setHidden_(!value);
    if (!value) input.setBrake(false);
}

function refresh() {
    if (readout === null || container === null || container.isHidden()) return;
    const live = input.current();
    readout.setText_(`${live.steer.toFixed(2)}\n${live.thrust.toFixed(2)}`);
}

module.exports = {
    build, setVisible, setBrakeVisible, refresh,
    box: () => container, brakeBox: () => brakeBox,
};
