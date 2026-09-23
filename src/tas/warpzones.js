// Death-warp zones per level: SCAN ZONES button and the warp-map rectangle.
//
// A warp needs (see warppredict.js for the mechanism): the level armed, a
// ResetPlayer (ocean) death, the spawn..death box overlapping EndFlare's box,
// and EndFlare ahead of ResetPlayer in that load's dbvt order. The third one
// is pure geometry and gives an exact zone per spawn:
//
//   per axis, pad = ball half size + DBVT margin
//     spawn inside [EF.min - pad, EF.max + pad]  -> any death coordinate
//     spawn above  EF.max + pad                  -> death <= EF.max + pad
//     spawn below  EF.min - pad                  -> death >= EF.min - pad
//   and height: EF.min.y <= spawn.y + pad, or no warp from that spawn at all.
//
// Inside the zone a death warps when the load's tree order is favourable
// (AUTO rerolls for that). Outside it, never. That is why L10 / L28 look
// scattered: the zone is a clean half-plane box, the red dots inside it are
// loads where ResetPlayer came first.
//
// EndFlare's box is measured live whenever a level is open and kept in
// warps-endflare.json (relative to the finish landmark). Levels not visited
// since use the median of the measured ones and are marked "est".

const mem = require('../core/mem');
const log = require('../core/log');
const storage = require('../core/storage');
const level = require('../game/level');

const EF_FILE = 'warps-endflare.json';
const ZONES_FILE = 'warps-zones.json';
const WORLD = 240;
const MARGIN = 0.05;
const START_LIFT = 1.5;       // loadLevel: ball spawn = StartPoint + 1.5 y
const CP_OFFSET_RVA = 0x1e0fd0; // CheckPoint branch adds this vector to the spawn
const DEFAULT_EF = { lo: [-7, -10.5, -7], hi: [7, 12, 7], r: 1 }; // from the 169-warp fit

let store = null;
let stamp = 0;

function efStore() {
    if (store === null) {
        const data = storage.readJson(EF_FILE);
        store = (data && typeof data === 'object') ? data : {};
    }
    return store;
}

function cpOffset() {
    try {
        const p = mem.base.add(CP_OFFSET_RVA);
        const v = [p.readFloat(), p.add(4).readFloat(), p.add(8).readFloat()];
        if (v.every(x => isFinite(x) && Math.abs(x) < 20)) return v;
    } catch (err) { /* */ }
    return [0, 4, 0];
}

function landmarks() {
    try { return require('./warplog').loadLandmarks(); } catch (err) { return {}; }
}

function arr(p) { return p ? [p.x, p.y, p.z] : null; }

// Record EndFlare's box for the open level (relative to its finish landmark).
function captureLive() {
    log.mark('warp.captureLive');
    try {
        if (!level.inLevel() || level.inMainMenu() || level.restartPending()) return false;
        const lv = level.levelNumber();
        const lm = landmarks()[String(lv)];
        const finish = lm && lm.finish ? arr(lm.finish) : null;
        const phys = mem.global('physics').readPointer();
        if (phys.isNull()) return false;
        const bp = phys.add(0x8).readPointer();
        const pred = require('./warppredict');
        const leaves = pred.leafOrder(bp.add(0x48).readPointer())
            .concat(pred.leafOrder(bp.add(0x08).readPointer()));
        const ef = leaves.find(l => l.name === 'EndFlare');
        if (!ef) return false;
        const base = finish || ef.mi.map((v, i) => (v + ef.mx[i]) / 2);
        let r = DEFAULT_EF.r;
        try {
            const ballModel = mem.global('ball').readPointer();
            const rb = ballModel.add(require('../core/ivars').offsetOf('synNode', 'rigidBody')).readPointer();
            const px = rb.add(0xc8).readPointer();
            const r3 = [0, 1, 2].map(i => (px.add(0x30 + i * 4).readFloat() - px.add(0x20 + i * 4).readFloat()) / 2);
            const m = Math.min.apply(null, r3);
            if (isFinite(m) && m > 0.2 && m < 5) r = m;
        } catch (err) { /* */ }
        const rec = {
            lo: ef.mi.map((v, i) => +(v - base[i]).toFixed(3)),
            hi: ef.mx.map((v, i) => +(v - base[i]).toFixed(3)),
            r: +r.toFixed(3),
            finish: base,
        };
        const all = efStore();
        const old = all[String(lv)];
        if (!old || JSON.stringify(old) !== JSON.stringify(rec)) {
            all[String(lv)] = rec;
            storage.writeJson(EF_FILE, all);
            stamp += 1;
        }
        return true;
    } catch (err) {
        return false;
    }
}

function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function efFor(lv, finish) {
    const all = efStore();
    const own = all[String(lv)];
    const pick = own || (function () {
        const recs = Object.keys(all).map(k => all[k]).filter(v => v && v.lo && v.hi);
        if (!recs.length) return DEFAULT_EF;
        return {
            lo: [0, 1, 2].map(i => median(recs.map(v => v.lo[i]))),
            hi: [0, 1, 2].map(i => median(recs.map(v => v.hi[i]))),
            r: median(recs.map(v => v.r || 1)),
        };
    }());
    return {
        mi: pick.lo.map((v, i) => finish[i] + v),
        mx: pick.hi.map((v, i) => finish[i] + v),
        r: pick.r || 1,
        est: !own,
    };
}

function axis(s, lo, hi) {
    if (s >= lo && s <= hi) return { min: -WORLD, max: WORLD, text: 'any' };
    if (s > hi) return { min: -WORLD, max: Math.min(WORLD, hi), text: `<= ${hi.toFixed(1)}` };
    return { min: Math.max(-WORLD, lo), max: WORLD, text: `>= ${lo.toFixed(1)}` };
}

// Spawns for a level: start pad + each CheckPoint.
function spawnsFor(lm) {
    const out = [];
    const off = cpOffset();
    if (lm.spawn) {
        out.push({ name: 'start', cp: false, p: [lm.spawn.x, lm.spawn.y + START_LIFT, lm.spawn.z] });
    }
    (lm.checkpoints || []).forEach(c => {
        if (!c || !isFinite(c.x)) return;
        if (c.name === 'spawn-jump') {
            if (!lm.spawn) out.push({ name: 'start', cp: false, p: [c.x, c.y, c.z] });
            return;
        }
        out.push({ name: c.name || 'CheckPoint', cp: true, p: [c.x + off[0], c.y + off[1], c.z + off[2]] });
    });
    return out;
}

// Exact zones baked from the game's LevelNNN.scn (tools/scn_zones.py):
// EndFlare's real box and the StartPoint / CheckPoint spawns, no estimate.
let baked = null;
function bakedFor(lv) {
    if (baked === null) {
        try { baked = require('./warpzones-data'); } catch (err) { baked = {}; }
    }
    const b = baked[String(lv)];
    return b && Array.isArray(b.layers) ? b : null;
}

function zonesFor(lv) {
    const b = bakedFor(lv);
    if (b !== null) {
        const lm0 = landmarks()[String(lv)];
        const seen = lm0 && lm0.movables ? lm0.movables : null;
        return {
            level: lv, est: false, exact: true,
            movables: seen ? (seen.count || 0) : b.movables.length,
            movableNames: seen ? (seen.names || []) : b.movables,
            layers: b.layers,
        };
    }
    const lm = landmarks()[String(lv)];
    if (!lm || !lm.finish) return null;
    const ef = efFor(lv, arr(lm.finish));
    const pad = ef.r + MARGIN;
    const movables = (lm.movables && lm.movables.count) || 0;
    return {
        level: lv, est: ef.est, movables,
        movableNames: (lm.movables && lm.movables.names) || [],
        layers: spawnsFor(lm).map(s => {
            const ax = axis(s.p[0], ef.mi[0] - pad, ef.mx[0] + pad);
            const az = axis(s.p[2], ef.mi[2] - pad, ef.mx[2] + pad);
            const top = s.p[1] + pad;
            const ok = ef.mi[1] <= top;
            return {
                name: s.name, cp: s.cp, spawn: s.p, ok,
                over: +(ef.mi[1] - top).toFixed(1),
                rect: { minX: ax.min, maxX: ax.max, minZ: az.min, maxZ: az.max },
                text: `x ${ax.text}, z ${az.text}`,
            };
        }),
    };
}

// Map rectangle for the level/layer on screen (cached; the map refreshes 15x/s).
const mapCache = { key: null, value: null, triedAt: 0 };

function mapZone(lv, cpOn) {
    if (bakedFor(lv) === null && efStore()[String(lv)] === undefined && Date.now() - mapCache.triedAt > 1000) {
        mapCache.triedAt = Date.now();
        if (level.levelNumber() === lv) captureLive();
    }
    const key = `${lv}/${cpOn ? 1 : 0}/${stamp}`;
    if (mapCache.key === key) return mapCache.value;
    let value = null;
    const z = zonesFor(lv);
    if (z) {
        const layer = z.layers.find(l => l.cp === !!cpOn) || null;
        if (layer) value = { ok: layer.ok, rect: layer.rect, text: layer.text, over: layer.over, est: z.est };
    }
    mapCache.key = key;
    mapCache.value = value;
    return value;
}

// SCAN ZONES: every level with landmarks. Short status line returned.
function scanAll() {
    return mem.withPool(function () {
        captureLive();
        const lm = landmarks();
        const levels = Object.keys(lm).map(k => parseInt(k, 10)).filter(isFinite).sort((a, b) => a - b);
        const out = [];
        let possible = 0;
        let noArm = 0;
        let tooHigh = 0;
        log.info(`zone scan: ${levels.length} level(s) with landmarks`
            + ` (EndFlare measured on ${Object.keys(efStore()).length}, rest estimated)`, 'warp');
        levels.forEach(lv => {
            const z = zonesFor(lv);
            if (!z) return;
            const parts = z.layers.map(l => (l.ok
                ? `${l.name}: ZONE ${l.text}`
                : `${l.name}: none (EndFlare ${l.over}u too high)`));
            const any = z.layers.some(l => l.ok);
            let verdict;
            if (!any) { verdict = 'IMPOSSIBLE'; tooHigh += 1; }
            else if (z.movables === 0) { verdict = 'ZONE BUT NOTHING TO ARM'; noArm += 1; }
            else { verdict = 'POSSIBLE'; possible += 1; }
            log.info(`  L${lv} ${verdict}${z.est ? ' (est)' : ''}  ${parts.join('  |  ')}`
                + `  movables ${z.movables}`, 'warp');
            out.push({ level: lv, verdict, est: z.est, movables: z.movableNames, layers: z.layers });
        });
        storage.writeJson(ZONES_FILE, { version: 1, levels: out });
        const msg = `${possible} possible, ${noArm} zone w/o movables, ${tooHigh} impossible`;
        log.info(`zone scan: ${msg} -> Documents/aerox-tas/${ZONES_FILE}`, 'warp');
        return msg;
    });
}

module.exports = { captureLive, zonesFor, mapZone, scanAll };
