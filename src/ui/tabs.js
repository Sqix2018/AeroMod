// Which TAS panel tabs are visible. SETTINGS stays on so this list can be edited.

const storage = require('../core/storage');

const FILE = 'ui-tabs.json';
const ALL = ['SPEED', 'TIME', 'MOVE', 'INPUT', 'MACRO', 'WARP', 'LOG', 'SKIN', 'ACHIEVE', 'SETTINGS'];
const DEFAULT_ON = {
    SPEED: true,
    TIME: true,
    MOVE: true,
    INPUT: true,
    MACRO: false,
    WARP: true,
    LOG: false,
    SKIN: false,
    ACHIEVE: true,
    SETTINGS: true,
};

const state = { on: null };

function load() {
    if (state.on !== null) return;
    const data = storage.readJson(FILE);
    state.on = {};
    ALL.forEach(name => {
        if (name === 'SETTINGS') state.on[name] = true;
        else if (data && typeof data[name] === 'boolean') state.on[name] = data[name];
        else state.on[name] = !!DEFAULT_ON[name];
    });
}

function persist() {
    load();
    storage.writeJson(FILE, state.on);
}

function isOn(name) {
    load();
    if (name === 'SETTINGS') return true;
    return !!state.on[name];
}

function setOn(name, on) {
    load();
    if (name === 'SETTINGS') return true;
    state.on[name] = !!on;
    persist();
    return state.on[name];
}

function visible() {
    load();
    return ALL.filter(isOn);
}

module.exports = { ALL, DEFAULT_ON, state, load, isOn, setOn, visible };
