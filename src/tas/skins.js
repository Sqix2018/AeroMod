// Extra TAS ball skins. These never write CurrentBallSelection. Closing the
// TAS puts the live HeroBall textures and materials back exactly as they were.
//
// Visuals borrow HeroBall03 meshes/materials (the tennis sphere) for wraps.
// Mirror stamps HeroBall00 chrome onto that sphere. Gold stamps HeroBall05
// (Change Ball slot 6) albedo onto the same sphere.
// Glass borrows HeroBall04 (Change Ball slot 5) and copies only the outer
// shell submeshes (SkyDome + DarkenReflect). Tendril lightning meshes stay
// on HeroBall04 and are not drawn on the live ball.
// DAT_ball, rigidBody, and initialWorldTransform stay on the official
// selection so ResetPlayer still snaps the same body the floor/movables use.
//
// synTexture.UvCoords is not a 0-based channel index. uploadSubMeshUVs:
//   0  = disable texcoords (one texel, looks like a color average)
//   1  = mesh uv1 (albedo)
//   2  = mesh uv2
//  -1  = view-aligned env (normals)
//  -2  = env from vertices
// Gameplay stamps SkyDomeA_.png onto every HeroBall with UvCoords -1.
// Put wraps in assets/skins then rebuild.

const log = require('../core/log');
const storage = require('../core/storage');
const mem = require('../core/mem');
const ball = require('../game/ball');
const frame = require('../game/frame');
const achievements = require('./achievements');
const offsets = require('../core/offsets');
const ivars = require('../core/ivars');
const defaults = require('./skin-defaults');

const TW = 256;
const TH = 256;

const FLAGS = [
    { id: 'us', title: 'USA' },
    { id: 'wa', title: 'Wales' },
    { id: 'au', title: 'Australia' },
    { id: 'en', title: 'England' },
    { id: 'be', title: 'Belgium' },
    { id: 'ca', title: 'Canada' },
];

const state = {
    applied: null,
    backup: null,
    ballKey: null,
    glId: 0,
    pending: null,
    installed: false,
    lastTry: 0,
    paint: null,
    held: [],
    lastError: null,
    failLogged: false,
    tries: 0,
    home: null,
    visual: null,
    shellBuf: null,
    parked: false,    // skin edits undone while the main menu is up
    goldId: 0,        // our brighter gold swatch (replaces HeroBallA_Gld)
};

// Skins edit the borrowed HeroBall03 (Change Ball 4) or HeroBall05 (gold,
// Change Ball 6) materials. Put its own look back while the main menu
// is up; re-apply the skin once a level is running again.
function menuGuard() {
    if (state.applied === null || state.backup === null) return;
    let menu = false;
    try {
        const lv = require('../game/level');
        menu = lv.inMainMenu() && !lv.inLevel();
    } catch (err) { return; }
    if (menu && !state.parked) {
        restoreSlots(state.backup);
        state.parked = true;
    } else if (!menu && state.parked) {
        state.parked = false;
        state.pending = state.applied;
    }
}

const GL_TEXTURE_2D = 0x0DE1;

function rgba(r, g, b, a) {
    return [
        Math.max(0, Math.min(255, Math.round(r * 255))),
        Math.max(0, Math.min(255, Math.round(g * 255))),
        Math.max(0, Math.min(255, Math.round(b * 255))),
        a === undefined ? 255 : Math.max(0, Math.min(255, Math.round(a * 255))),
    ];
}

function pack(c) {
    return (c[0] | (c[1] << 8) | (c[2] << 16) | (c[3] << 24)) >>> 0;
}

function allocPixels() {
    return Memory.alloc(TW * TH * 4);
}

function fillR(buf, x, y, w, h, c) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(TW, Math.ceil(x + w));
    const y1 = Math.min(TH, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const pixel = pack(c);
    for (let j = y0; j < y1; j++) {
        let p = buf.add((j * TW + x0) * 4);
        for (let i = x0; i < x1; i++) {
            p.writeU32(pixel);
            p = p.add(4);
        }
    }
}

function oval(buf, x, y, w, h, c) {
    const rx = w / 2;
    const ry = h / 2;
    if (rx <= 0 || ry <= 0) return;
    const cx = x + rx;
    const cy = y + ry;
    const pixel = pack(c);
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(TH, Math.ceil(y + h));
    for (let j = y0; j < y1; j++) {
        const ny = (j + 0.5 - cy) / ry;
        const inner = 1 - ny * ny;
        if (inner <= 0) continue;
        const half = rx * Math.sqrt(inner);
        const x0 = Math.max(0, Math.floor(cx - half));
        const x1 = Math.min(TW, Math.ceil(cx + half));
        let p = buf.add((j * TW + x0) * 4);
        for (let i = x0; i < x1; i++) {
            p.writeU32(pixel);
            p = p.add(4);
        }
    }
}

function drawGlobe(buf) {
    fillR(buf, 0, 0, TW, TH, rgba(0.08, 0.22, 0.48));
    [[20, 70, 90, 50], [80, 40, 70, 40], [140, 90, 90, 55],
        [200, 50, 50, 45], [40, 160, 80, 40], [160, 170, 70, 35],
    ].forEach(b => oval(buf, b[0], b[1], b[2], b[3], rgba(0.18, 0.55, 0.28)));
}

function drawEye(buf) {
    fillR(buf, 0, 0, TW, TH, rgba(0.96, 0.94, 0.92));
    oval(buf, TW / 2 - 70, TH / 2 - 70, 140, 140, rgba(0.15, 0.45, 0.55));
    oval(buf, TW / 2 - 28, TH / 2 - 28, 56, 56, rgba(0.05, 0.05, 0.06));
    oval(buf, TW / 2 + 8, TH / 2 - 22, 16, 16, rgba(1, 1, 1, 0.7));
}

function put(buf, x, y, c) {
    if (x < 0 || y < 0 || x >= TW || y >= TH) return;
    buf.add((y * TW + x) * 4).writeU32(pack(c));
}

function drawGlass(buf) {
    for (let y = 0; y < TH; y++) {
        for (let x = 0; x < TW; x++) {
            const u = x / TW;
            const v = y / TH;
            const diag = u * 0.7 + v * 0.3;
            const band = Math.exp(-Math.pow((diag - 0.4) / 0.1, 2));
            const spec = Math.exp(-((u - 0.3) * (u - 0.3) + (v - 0.26) * (v - 0.26)) / 0.035);
            const edge = Math.pow(Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2, 2.2);
            const t = 0.72 + band * 0.2 + spec * 0.16 - edge * 0.28;
            const c = Math.max(0.38, Math.min(0.98, t));
            put(buf, x, y, rgba(c, c + 0.02, c + 0.05, 0.88));
        }
    }
}

function drawComet(buf) {
    fillR(buf, 0, 0, TW, TH, rgba(0.05, 0.04, 0.10));
    for (let i = 0; i < 10; i++) {
        oval(buf, 16 + i * 22, 100 + (i % 3) * 10, 36, 16, rgba(1.0, 0.55, 0.12));
    }
    oval(buf, TW - 80, TH / 2 - 28, 56, 56, rgba(1.0, 0.85, 0.4));
}

function drawGolf(buf) {
    fillR(buf, 0, 0, TW, TH, rgba(0.92, 0.93, 0.90));
    for (let y = 8; y < TH; y += 18) {
        const odd = ((y / 18) | 0) % 2;
        for (let x = 6 + odd * 10; x < TW; x += 20) {
            oval(buf, x, y, 9, 7, rgba(0.72, 0.74, 0.70));
        }
    }
}

function drawFlag(buf, id) {
    if (id === 'us') {
        for (let r = 0; r < 13; r++) {
            fillR(buf, 0, r * (TH / 13), TW, TH / 13,
                r % 2 === 0 ? rgba(0.75, 0.12, 0.16) : rgba(1, 1, 1));
        }
        fillR(buf, 0, 0, TW * 0.4, TH * 0.54, rgba(0.0, 0.13, 0.4));
        for (let i = 0; i < 20; i++) {
            oval(buf, 8 + (i % 5) * 18, 8 + Math.floor(i / 5) * 16, 6, 6, rgba(1, 1, 1));
        }
    } else if (id === 'en') {
        fillR(buf, 0, 0, TW, TH, rgba(1, 1, 1));
        const red = rgba(0.78, 0.06, 0.18);
        function enCross(cx) {
            fillR(buf, cx * TW - TW * 0.22, TH * 0.39, TW * 0.44, TH * 0.22, red);
            fillR(buf, cx * TW - TW * 0.07, 0, TW * 0.14, TH, red);
        }
        enCross(0.5);
        enCross(0.0);
        enCross(1.0);
    } else if (id === 'be') {
        fillR(buf, 0, 0, TW / 3, TH, rgba(0, 0, 0));
        fillR(buf, TW / 3, 0, TW / 3, TH, rgba(0.98, 0.82, 0.1));
        fillR(buf, (TW * 2) / 3, 0, TW / 3, TH, rgba(0.78, 0.08, 0.14));
    } else if (id === 'ca') {
        fillR(buf, 0, 0, TW * 0.25, TH, rgba(0.85, 0.1, 0.14));
        fillR(buf, TW * 0.25, 0, TW * 0.5, TH, rgba(1, 1, 1));
        fillR(buf, TW * 0.75, 0, TW * 0.25, TH, rgba(0.85, 0.1, 0.14));
        oval(buf, TW / 2 - 22, TH / 2 - 28, 44, 56, rgba(0.85, 0.1, 0.14));
    } else if (id === 'au') {
        fillR(buf, 0, 0, TW, TH, rgba(0.0, 0.14, 0.45));
        fillR(buf, 0, 0, TW * 0.42, TH * 0.5, rgba(0.0, 0.08, 0.32));
        fillR(buf, 0, TH * 0.22, TW * 0.42, TH * 0.08, rgba(1, 1, 1));
        fillR(buf, TW * 0.18, 0, TW * 0.07, TH * 0.5, rgba(1, 1, 1));
        fillR(buf, 0, TH * 0.23, TW * 0.42, TH * 0.05, rgba(0.8, 0.08, 0.12));
        fillR(buf, TW * 0.185, 0, TW * 0.05, TH * 0.5, rgba(0.8, 0.08, 0.12));
        [[0.62, 0.28], [0.78, 0.22], [0.86, 0.42], [0.7, 0.55], [0.55, 0.7], [0.72, 0.78],
        ].forEach(p => oval(buf, p[0] * TW, p[1] * TH, 8, 8, rgba(1, 1, 1)));
    } else {
        fillR(buf, 0, 0, TW, TH * 0.5, rgba(1, 1, 1));
        fillR(buf, 0, TH * 0.5, TW, TH * 0.5, rgba(0.0, 0.45, 0.22));
        oval(buf, TW / 2 - 32, TH / 2 - 28, 64, 40, rgba(0.75, 0.08, 0.12));
        fillR(buf, TW / 2 - 6, TH / 2 - 40, 12, 56, rgba(0.75, 0.08, 0.12));
    }
}

function paintFor(kind) {
    const flag = achievements.state.flag || 'us';
    if (state.paint !== null && state.paint.kind === kind
        && (kind !== 'flag' || state.paint.flag === flag)) {
        return state.paint.pixels;
    }
    const buf = allocPixels();
    fillR(buf, 0, 0, TW, TH, rgba(0.2, 0.2, 0.2));
    if (kind === 'globe') drawGlobe(buf);
    else if (kind === 'eyeball') drawEye(buf);
    else if (kind === 'comet') drawComet(buf);
    else if (kind === 'golf') drawGolf(buf);
    else if (kind === 'galaxy') drawComet(buf);
    else if (kind === 'clock') drawGolf(buf);
    else if (kind === 'neon') drawComet(buf);
    else if (kind === 'flag') drawFlag(buf, flag);
    else if (kind === 'glass') drawGlass(buf);
    else return null;
    const pixels = { buf, w: TW, h: TH };
    state.paint = { kind, flag, pixels };
    return pixels;
}

function writeBmp(pixels, fileName) {
    const w = pixels.w;
    const h = pixels.h;
    const row = (w * 3 + 3) & ~3;
    const pixelBytes = row * h;
    const header = 54;
    const total = header + pixelBytes;
    const buf = Memory.alloc(total);
    buf.writeU8(0x42);
    buf.add(1).writeU8(0x4D);
    buf.add(2).writeU32(total);
    buf.add(6).writeU32(0);
    buf.add(10).writeU32(header);
    buf.add(14).writeU32(40);
    buf.add(18).writeS32(w);
    buf.add(22).writeS32(h);
    buf.add(26).writeU16(1);
    buf.add(28).writeU16(24);
    buf.add(30).writeU32(0);
    buf.add(34).writeU32(pixelBytes);
    buf.add(38).writeU32(0);
    buf.add(42).writeU32(0);
    buf.add(46).writeU32(0);
    buf.add(50).writeU32(0);
    for (let y = 0; y < h; y++) {
        const srcY = h - 1 - y;
        let p = buf.add(header + y * row);
        for (let x = 0; x < w; x++) {
            const s = pixels.buf.add((srcY * w + x) * 4);
            p.writeU8(s.add(2).readU8());
            p.add(1).writeU8(s.add(1).readU8());
            p.add(2).writeU8(s.readU8());
            p = p.add(3);
        }
    }
    const dir = storage.directory();
    if (dir === null) return null;
    const path = `${dir}/${fileName}`;
    const data = ObjC.classes.NSData.dataWithBytes_length_(buf, total);
    if (!data.writeToFile_atomically_(path, true)) return null;
    return path;
}

function previewImage(kind) {
    try { seedDefaultPng(kind); } catch (err) { /* */ }
    const user = userSkinPath(kind);
    if (user !== null) {
        try {
            const img = ObjC.classes.UIImage.imageWithContentsOfFile_(user);
            if (img !== null) return img;
        } catch (err) { /* */ }
    }
    return null;
}

function sweepJunk() {
    const fm = ObjC.classes.NSFileManager.defaultManager();
    const dirs = [];
    try {
        const root = storage.directory();
        if (root !== null) dirs.push(root);
    } catch (err) { /* */ }
    try {
        const dir = skinsDir();
        if (dir !== null) dirs.push(dir);
    } catch (err) { /* */ }
    const named = [
        'globe.bmp', 'eyeball.bmp', 'Eye.bmp', 'eye.bmp',
        'preview-eyeball.bmp', 'preview-eyeball.tmp',
        'preview-globe.bmp', 'preview-globe.tmp',
        'preview-glass.bmp', 'preview-comet.bmp', 'preview-golf.bmp', 'preview-mirror.bmp',
        'preview-flag.bmp',
    ];
    let removed = 0;
    for (let d = 0; d < dirs.length; d++) {
        for (let i = 0; i < named.length; i++) {
            const path = `${dirs[d]}/${named[i]}`;
            try {
                if (fm.fileExistsAtPath_(path) && fm.removeItemAtPath_error_(path, NULL)) {
                    removed += 1;
                }
            } catch (err) { /* */ }
        }
        try {
            const items = fm.contentsOfDirectoryAtPath_error_(dirs[d], NULL);
            if (items === null) continue;
            const n = items.count();
            for (let i = 0; i < n; i++) {
                const name = items.objectAtIndex_(i).toString();
                const junk = name.indexOf('preview-') === 0
                    || (name.indexOf('.tmp') === name.length - 4 && name.length > 4);
                if (!junk) continue;
                if (!(name.indexOf('.bmp') === name.length - 4 || name.indexOf('.tmp') === name.length - 4)) {
                    continue;
                }
                try {
                    if (fm.removeItemAtPath_error_(`${dirs[d]}/${name}`, NULL)) removed += 1;
                } catch (err) { /* */ }
            }
        } catch (err) { /* */ }
    }
    if (removed > 0) {
        console.log(`[aerox-tas] skins: removed ${removed} leftover bmp/preview file(s)`);
    }
}

function swatch(kind) {
    if (kind === 'globe') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.12, 0.42, 0.28, 1);
    if (kind === 'eyeball') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.9, 0.9, 0.88, 1);
    if (kind === 'comet') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(1.0, 0.55, 0.12, 1);
    if (kind === 'golf') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.88, 0.90, 0.84, 1);
    if (kind === 'galaxy') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.18, 0.12, 0.45, 1);
    if (kind === 'clock') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.82, 0.62, 0.18, 1);
    if (kind === 'neon') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.15, 0.95, 0.55, 1);
    if (kind === 'gold') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.92, 0.72, 0.18, 1);
    if (kind === 'flag') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.75, 0.12, 0.16, 1);
    if (kind === 'mirror') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.7, 0.75, 0.8, 1);
    if (kind === 'glass') return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.55, 0.75, 0.85, 0.5);
    return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.3, 0.3, 0.3, 1);
}

function makeCurrent() {
    const handle = frame.state.view;
    if (handle === null) return false;
    try {
        const view = new ObjC.Object(handle);
        let ctx = null;
        if (typeof view.context === 'function') ctx = view.context();
        else if (typeof view['- context'] === 'function') ctx = view['- context']();
        if (ctx === null || ctx === undefined) return false;
        ObjC.classes.EAGLContext.setCurrentContext_(ctx);
        return true;
    } catch (err) {
        return false;
    }
}

function gameGl(name, ret, args) {
    const rva = offsets.resolve().layout.glImports[name];
    if (rva === undefined) throw new Error('no GOT for ' + name);
    const fn = mem.base.add(rva).readPointer();
    if (fn.isNull()) throw new Error(name + ' GOT empty');
    return new NativeFunction(fn, ret, args);
}

function finishGlTexture(id) {
    const bind = gameGl('glBindTexture', 'void', ['uint', 'uint']);
    const param = gameGl('glTexParameteri', 'void', ['uint', 'uint', 'int']);
    bind(GL_TEXTURE_2D, id);
    // LINEAR, no mip chain. LINEAR_MIPMAP_LINEAR + tiled UVs samples the 1x1
    // top mip, which is the average color of the whole PNG.
    param(GL_TEXTURE_2D, 0x2801, 0x2601);
    param(GL_TEXTURE_2D, 0x2800, 0x2601);
    param(GL_TEXTURE_2D, 0x8191, 0);
    param(GL_TEXTURE_2D, 0x2802, 0x2901);
    param(GL_TEXTURE_2D, 0x2803, 0x2901);
}

// Overwrite an existing HeroBall albedo. The game already created that GL
// name during getTextureIds_; we only replace the texels, same as a reload.
function upload(pixels, existingId) {
    makeCurrent();
    const bind = gameGl('glBindTexture', 'void', ['uint', 'uint']);
    const image = gameGl('glTexImage2D', 'void',
        ['uint', 'int', 'int', 'int', 'int', 'int', 'uint', 'uint', 'pointer']);
    let id = existingId | 0;
    if (!id) {
        const gen = gameGl('glGenTextures', 'void', ['int', 'pointer']);
        const out = Memory.alloc(4);
        gen(1, out);
        id = out.readU32();
    }
    if (!id) throw new Error('GL texture id 0');
    bind(GL_TEXTURE_2D, id);
    finishGlTexture(id);
    image(GL_TEXTURE_2D, 0, 0x1908, pixels.w, pixels.h, 0, 0x1908, 0x1401, pixels.buf);
    finishGlTexture(id);
    return id;
}

function cgExport(name) {
    const p = mem.findExport('CoreGraphics', name) || mem.findExport(null, name);
    if (p === null) throw new Error('no ' + name);
    return p;
}

function uiExport(name) {
    const p = mem.findExport('UIKit', name)
        || mem.findExport('UIKitCore', name)
        || mem.findExport(null, name);
    if (p === null) throw new Error('no ' + name);
    return p;
}

function imagePixelSize(img) {
    let scale = 1;
    try {
        scale = typeof img.scale === 'function' ? Number(img.scale()) : Number(img.scale);
    } catch (err) { scale = 1; }
    if (!isFinite(scale) || scale < 1) scale = 1;
    let w = 0;
    let h = 0;
    try {
        const sz = img.size();
        if (sz !== null && sz !== undefined) {
            if (typeof sz.width === 'number') {
                w = sz.width;
                h = sz.height;
            } else if (sz[0] !== undefined) {
                w = Number(sz[0]);
                h = Number(sz[1]);
            }
        }
    } catch (err) { /* */ }
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    if (w >= 2 && h >= 2) return { w, h };
    throw new Error('image size');
}

function drawImageInContext(img, w, h, x, y) {
    const left = x === undefined ? 0 : x;
    const top = y === undefined ? 0 : y;
    const rects = [
        [[left, top], [w, h]],
        { origin: { x: left, y: top }, size: { width: w, height: h } },
    ];
    for (let i = 0; i < rects.length; i++) {
        try {
            img.drawInRect_(rects[i]);
            return true;
        } catch (err) { /* */ }
    }
    try {
        img.drawAtPoint_([left, top]);
        return true;
    } catch (err) {
        return false;
    }
}

function cgImageOf(img) {
    try {
        if (typeof img.CGImage === 'function') {
            const p = img.CGImage();
            if (p !== null && p !== undefined && !ptr(p).isNull()) return ptr(p);
        }
    } catch (err) { /* */ }
    try {
        const p = img['CGImage']();
        if (p !== null && p !== undefined && !ptr(p).isNull()) return ptr(p);
    } catch (err) { /* */ }
    return null;
}

function drawCgImage(ctx, img, w, h, x, y) {
    const cg = cgImageOf(img);
    if (cg === null) return false;
    try {
        const draw = new NativeFunction(cgExport('CGContextDrawImage'), 'void',
            ['pointer', 'double', 'double', 'double', 'double', 'pointer']);
        draw(ctx, x, y, w, h, cg);
        return true;
    } catch (err) { /* */ }
    try {
        const draw = new NativeFunction(cgExport('CGContextDrawImage'), 'void',
            ['pointer', ['double', 'double', 'double', 'double'], 'pointer']);
        draw(ctx, [x, y, w, h], cg);
        return true;
    } catch (err) {
        return false;
    }
}

function rasterize(img) {
    const dim = imagePixelSize(img);
    // Sphere albedo is 2:1 (equirect). Any PNG/JPEG is scaled to cover 1024x512
    // and center-cropped so a 1918x960 2:1 photo still fills the tennis UVs.
    // Texture2D.initWithImagePath pads NPOT to the next POT (2048x1024 for
    // comet.jpg) which leaves a seam of empty texels, so we never hand the
    // original file to Texture2D until this 1024x512 blit has failed.
    const w = 1024;
    const h = 512;
    const scale = Math.max(w / Math.max(dim.w, 1), h / Math.max(dim.h, 1));
    const dw = dim.w * scale;
    const dh = dim.h * scale;
    const ox = (w - dw) / 2;
    const oy = (h - dh) / 2;
    const buf = Memory.alloc(w * h * 4);
    const spaceFn = new NativeFunction(cgExport('CGColorSpaceCreateDeviceRGB'), 'pointer', []);
    const ctxFn = new NativeFunction(cgExport('CGBitmapContextCreate'), 'pointer',
        ['pointer', 'size_t', 'size_t', 'size_t', 'size_t', 'pointer', 'uint32']);
    const relCtx = new NativeFunction(cgExport('CGContextRelease'), 'void', ['pointer']);
    const relSpace = new NativeFunction(cgExport('CGColorSpaceRelease'), 'void', ['pointer']);
    const translate = new NativeFunction(cgExport('CGContextTranslateCTM'), 'void',
        ['pointer', 'double', 'double']);
    const scaleCtm = new NativeFunction(cgExport('CGContextScaleCTM'), 'void',
        ['pointer', 'double', 'double']);
    const space = spaceFn();
    // PremultipliedLast + 32Big = RGBA for glTexImage2D GL_RGBA.
    const ctx = ctxFn(buf, w, h, 8, w * 4, space, 16384 | 1);
    if (ctx.isNull()) {
        relSpace(space);
        throw new Error('bitmap ctx');
    }
    translate(ctx, 0, h);
    scaleCtm(ctx, 1, -1);
    let drawn = drawCgImage(ctx, img, dw, dh, ox, oy);
    if (!drawn) {
        const push = new NativeFunction(uiExport('UIGraphicsPushContext'), 'void', ['pointer']);
        const pop = new NativeFunction(uiExport('UIGraphicsPopContext'), 'void', []);
        push(ctx);
        drawn = drawImageInContext(img, dw, dh, ox, oy);
        pop();
    }
    relCtx(ctx);
    relSpace(space);
    if (!drawn) throw new Error('drawInRect');
    let max = 0;
    const step = Math.max(1, ((w * h) / 128) | 0);
    for (let i = 0; i < w * h; i += step) {
        const p = buf.add(i * 4);
        const v = p.readU8() | p.add(1).readU8() | p.add(2).readU8();
        if (v > max) max = v;
    }
    if (max < 4) throw new Error('empty png');
    return { buf, w, h };
}

function pixelsFromFile(path) {
    const img = ObjC.classes.UIImage.imageWithContentsOfFile_(path);
    if (img === null || img.handle.isNull()) throw new Error('UIImage load');
    return rasterize(img);
}

function pixelsFromEmbed(kind) {
    const keys = defaultKeys(kind);
    for (let i = 0; i < keys.length; i++) {
        const b64 = defaults[keys[i]];
        if (!b64) continue;
        try {
            const ns = ObjC.classes.NSString.stringWithString_(b64);
            const data = ObjC.classes.NSData.alloc()
                .initWithBase64EncodedString_options_(ns, 0);
            if (data === null) continue;
            try {
                const img = ObjC.classes.UIImage.imageWithData_(data);
                if (img === null || img.handle.isNull()) continue;
                return rasterize(img);
            } finally {
                try { data.release(); } catch (err) { /* */ }
            }
        } catch (err) { /* */ }
    }
    return null;
}

function texture2DName(tex) {
    let id = 0;
    try { id = Number(tex.name()); } catch (err) { /* */ }
    if (!id) {
        try { id = tex.handle.add(0x14).readU32(); } catch (err) { /* */ }
    }
    return id | 0;
}

function uploadTexture2D(path) {
    const cls = ObjC.classes.Texture2D;
    if (cls === undefined) throw new Error('Texture2D');
    makeCurrent();
    const ns = ObjC.classes.NSString.stringWithString_(path);
    const tex = cls.alloc();
    if (tex === null || tex.handle.isNull()) throw new Error('Texture2D alloc');
    const sel = ObjC.selector('initWithImagePath:');
    const attempts = [
        function () { if (typeof tex.initWithImagePath_ === 'function') tex.initWithImagePath_(ns); else throw new Error('no initWithImagePath_'); },
        function () { if (typeof tex['initWithImagePath:'] === 'function') tex['initWithImagePath:'](ns); else throw new Error('no initWithImagePath:'); },
        function () { if (typeof tex.performSelector_withObject_ === 'function') tex.performSelector_withObject_(sel, ns); else throw new Error('no performSelector'); },
        function () { if (typeof tex['performSelector:withObject:'] === 'function') tex['performSelector:withObject:'](sel, ns); else throw new Error('no performSelector:'); },
    ];
    let last = 'initWithImagePath';
    for (let i = 0; i < attempts.length; i++) {
        try {
            attempts[i]();
            const id = texture2DName(tex);
            if (id) {
                state.held = [tex];
                try { finishGlTexture(id); } catch (err) { /* */ }
                return id;
            }
            last = 'Texture2D id 0';
        } catch (err) {
            last = err.message;
        }
    }
    throw new Error(last);
}

function deleteGlTexture(id) {
    const n = id | 0;
    if (!n) return false;
    try {
        makeCurrent();
        const del = gameGl('glDeleteTextures', 'void', ['int', 'pointer']);
        if (!deleteGlTexture.buf) deleteGlTexture.buf = Memory.alloc(4);
        deleteGlTexture.buf.writeU32(n);
        del(1, deleteGlTexture.buf);
        return true;
    } catch (err) {
        if (!deleteGlTexture.logged) {
            deleteGlTexture.logged = true;
            log.info(`skin glDelete ${n} failed: ${err.message}`, 'mem');
        }
        return false;
    }
}

function takeWrapId(id) {
    const next = id | 0;
    if (state.glId && next && state.glId !== next) {
        const ok = deleteGlTexture(state.glId);
        log.info(`skin gl ${state.glId} -> ${next} delete=${ok ? 'ok' : 'fail'}`, 'mem');
    }
    if (next) state.glId = next;
    return next;
}

function loadWrap(kind) {
    const user = userSkinPath(kind);
    if (user !== null) {
        try {
            const pixels = pixelsFromFile(user);
            state.held = [];
            const id = upload(pixels, state.glId);
            pixels.buf = null;
            return { id, w: pixels.w, h: pixels.h };
        } catch (err) {
            if (!loadWrap.rasterLogged) {
                loadWrap.rasterLogged = true;
                log.info(`skin rasterize failed (${err.message}), Texture2D fallback`, 'mem');
            }
        }
        try {
            const img = ObjC.classes.UIImage.imageWithContentsOfFile_(user);
            const dim = img ? imagePixelSize(img) : { w: 0, h: 0 };
            // NPOT / oversized files pad to the next POT and can jetsam.
            if (dim.w === 1024 && dim.h === 512) {
                return { id: uploadTexture2D(user), w: dim.w, h: dim.h };
            }
        } catch (err) { /* */ }
    }
    try {
        const embed = pixelsFromEmbed(kind);
        if (embed !== null) {
            state.held = [];
            const id = upload(embed, state.glId);
            embed.buf = null;
            return { id, w: embed.w, h: embed.h };
        }
    } catch (err) { /* */ }
    const pixels = paintFor(kind);
    if (pixels === null) throw new Error('unknown skin');
    state.held = [];
    return { id: upload(pixels, state.glId), w: pixels.w, h: pixels.h };
}

function liftDark(pixels, minLuma) {
    const n = pixels.w * pixels.h;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const p = pixels.buf.add(i * 4);
        sum += p.readU8() + p.add(1).readU8() + p.add(2).readU8();
    }
    const avg = sum / (n * 3);
    if (avg >= minLuma) return avg;
    const gain = minLuma / Math.max(avg, 1);
    for (let i = 0; i < n; i++) {
        const p = pixels.buf.add(i * 4);
        p.writeU8(Math.min(255, (p.readU8() * gain) | 0));
        p.add(1).writeU8(Math.min(255, (p.add(1).readU8() * gain) | 0));
        p.add(2).writeU8(Math.min(255, (p.add(2).readU8() * gain) | 0));
        if (p.add(3).readU8() < 170) p.add(3).writeU8(170);
    }
    return avg;
}

function model() {
    try { return ball.model(); } catch (err) { return null; }
}

function textureNameOf(tex) {
    try {
        const n = tex.textureName();
        if (n === null || n === undefined) return '';
        return n.toString();
    } catch (err) { return ''; }
}

function isSky(tex) {
    return /skydome|falloff/i.test(textureNameOf(tex));
}

function eachTexture(modelObj, fn) {
    if (modelObj === null) return;
    const node = new ObjC.Object(modelObj);
    let n = 0;
    try { n = Number(node.numOfSubMeshes()); } catch (err) { return; }
    let mats;
    try { mats = node.modelMaterials(); } catch (err) { return; }
    if (mats === null) return;
    for (let i = 0; i < n; i++) {
        let mat = null;
        try {
            if (typeof mats.count === 'function') {
                if (i >= mats.count()) break;
                mat = mats.objectAtIndex_(i);
            } else {
                const p = ptr(mats).add(i * Process.pointerSize).readPointer();
                if (p.isNull()) continue;
                mat = new ObjC.Object(p);
            }
        } catch (err) { continue; }
        if (mat === null) continue;
        let maps = 1;
        try { maps = Number(mat.numOfMaps()); } catch (err) { /* */ }
        let texs;
        try { texs = mat.textures(); } catch (err) { continue; }
        for (let j = 0; j < maps; j++) {
            try {
                let tex = null;
                if (texs && typeof texs.count === 'function') {
                    if (j >= texs.count()) break;
                    tex = texs.objectAtIndex_(j);
                } else {
                    const tp = ptr(texs).add(j * Process.pointerSize).readPointer();
                    if (tp.isNull()) continue;
                    tex = new ObjC.Object(tp);
                }
                if (tex !== null) fn(tex, mat, j);
            } catch (err) { /* */ }
        }
    }
}

function snapshot(modelObj) {
    const slots = [];
    eachTexture(modelObj, (tex, mat, mapIndex) => {
        const s = {
            tex, mat, mapIndex, id: 0, trans: 0, isT: false, refl: false,
            sky: isSky(tex), useCol: false, r: 1, g: 1, b: 1, a: 1, ds: false,
            uv: 0, mode: 0, uTile: 1, vTile: 1, wrapU: 1, wrapV: 1, mip: false,
            lod: 0,
        };
        try { s.id = tex.textureId(); } catch (err) { /* */ }
        try { s.trans = mat.transparencyType(); } catch (err) { /* */ }
        try { s.isT = !!mat.isTransparent(); } catch (err) { /* */ }
        try { s.refl = !!tex.viewAlignedReflections(); } catch (err) { /* */ }
        try { s.useCol = !!mat.useMaterialColor(); } catch (err) { /* */ }
        try { s.r = mat.redMeshColor(); } catch (err) { /* */ }
        try { s.g = mat.greenMeshColor(); } catch (err) { /* */ }
        try { s.b = mat.blueMeshColor(); } catch (err) { /* */ }
        try { s.a = mat.meshAlpha(); } catch (err) { /* */ }
        try { s.ds = !!mat.isDoubleSided(); } catch (err) { /* */ }
        try { s.uv = tex.UvCoords(); } catch (err) { /* */ }
        try { s.mode = tex.textureMode(); } catch (err) { /* */ }
        try { s.uTile = tex.uTile(); } catch (err) { s.uTile = 1; }
        try { s.vTile = tex.vTile(); } catch (err) { s.vTile = 1; }
        try { s.wrapU = tex.textureTileOrMirrorU(); } catch (err) { s.wrapU = 1; }
        try { s.wrapV = tex.textureTileOrMirrorV(); } catch (err) { s.wrapV = 1; }
        try { s.mip = !!tex.genMipmapsAtUpload(); } catch (err) { /* */ }
        try { s.lod = tex.lod_bias(); } catch (err) { s.lod = 0; }
        slots.push(s);
    });
    return slots;
}

function restoreSlots(slots) {
    if (!slots) return;
    slots.forEach(s => {
        try { s.tex.setTextureId_(s.id); } catch (err) { /* */ }
        try { s.mat.setTransparencyType_(s.trans); } catch (err) { /* */ }
        try { s.mat.setIsTransparent_(s.isT); } catch (err) { /* */ }
        try { s.tex.setViewAlignedReflections_(s.refl); } catch (err) { /* */ }
        try { s.mat.setUseMaterialColor_(s.useCol ? 1 : 0); } catch (err) { /* */ }
        try { s.mat.setRedMeshColor_(s.r); } catch (err) { /* */ }
        try { s.mat.setGreenMeshColor_(s.g); } catch (err) { /* */ }
        try { s.mat.setBlueMeshColor_(s.b); } catch (err) { /* */ }
        try { s.mat.setMeshAlpha_(s.a); } catch (err) { /* */ }
        try { s.mat.setIsDoubleSided_(s.ds ? 1 : 0); } catch (err) { /* */ }
        try { s.tex.setUvCoords_(s.uv); } catch (err) { /* */ }
        try { s.tex.setTextureMode_(s.mode); } catch (err) { /* */ }
        try { s.tex.setUTile_(s.uTile); } catch (err) { /* */ }
        try { s.tex.setVTile_(s.vTile); } catch (err) { /* */ }
        try { s.tex.setTextureTileOrMirrorU_(s.wrapU); } catch (err) { /* */ }
        try { s.tex.setTextureTileOrMirrorV_(s.wrapV); } catch (err) { /* */ }
        try { s.tex.setGenMipmapsAtUpload_(s.mip ? 1 : 0); } catch (err) { /* */ }
        try { s.tex.setLod_bias_(s.lod); } catch (err) { /* */ }
    });
}

function pickBall(index) {
    try {
        const n = mem.global('ballCount').readS32();
        const arr = mem.global('ballArray').readPointer();
        if (arr.isNull() || index < 0 || index >= n) return null;
        const p = arr.add(index * Process.pointerSize).readPointer();
        return p.isNull() ? null : p;
    } catch (err) { return null; }
}

function pickSphere() {
    return pickBall(3);
}

function pickPlasma() {
    return pickBall(4);
}

function liveSkyId() {
    try {
        const p = mem.global('skyRtt').readPointer();
        if (p.isNull()) return 0;
        return new ObjC.Object(p).glTextureNum() | 0;
    } catch (err) {
        return 0;
    }
}

function stealChrome() {
    const src = pickBall(0);
    if (src === null) return null;
    const slots = snapshot(src);
    if (slots.length === 0) return null;
    let hit = null;
    for (let i = 0; i < slots.length; i++) {
        const uv = slots[i].uv | 0;
        if (slots[i].sky || uv < 0 || uv === 255 || uv === 254) {
            hit = slots[i];
            break;
        }
    }
    if (hit === null) hit = slots[slots.length - 1];
    return {
        id: hit.id | 0,
        uv: hit.uv,
        mode: hit.mode,
        name: textureNameOf(hit.tex),
    };
}

function pickCommonTex(slots, allowEnv) {
    const counts = {};
    const byId = {};
    slots.forEach(s => {
        const id = s.id | 0;
        if (!id || s.sky) return;
        if (!allowEnv && isEnvSlot(s)) return;
        counts[id] = (counts[id] || 0) + 1;
        if (!byId[id]) byId[id] = s;
    });
    let hit = null;
    let best = 0;
    Object.keys(counts).forEach(id => {
        if (counts[id] > best) {
            best = counts[id];
            hit = byId[id];
        }
    });
    return hit;
}

// Same look that worked as 100% chrome: live sky id on every map, UvCoords -1,
// view-aligned reflections, opaque. Capture BEFORE borrowing tennis materials
// onto HeroBall00 or stealChrome reads felt instead of SkyDome.
function captureChrome() {
    const sky = liveSkyId();
    const stolen = stealChrome();
    const id = sky || (stolen && stolen.id) || 0;
    return {
        id,
        mode: stolen ? (stolen.mode | 0) : 0,
        name: stolen && stolen.name ? stolen.name : 'skyRtt',
    };
}

function applyFullChrome(slots, chrome) {
    const envId = chrome && chrome.id ? chrome.id : 0;
    slots.forEach(s => {
        try { s.mat.setUseMaterialColor_(0); } catch (err) { /* */ }
        try { s.mat.setMeshAlpha_(1); } catch (err) { /* */ }
        try { s.mat.setIsTransparent_(0); } catch (err) { /* */ }
        try { s.mat.setTransparencyType_(0); } catch (err) { /* */ }
        if (envId) {
            try { s.tex.setTextureId_(envId); } catch (err) { /* */ }
        }
        try { s.tex.setUvCoords_(-1); } catch (err) { /* */ }
        try { s.tex.setViewAlignedReflections_(1); } catch (err) { /* */ }
        if (chrome) {
            try { s.tex.setTextureMode_(chrome.mode | 0); } catch (err) { /* */ }
        }
    });
}

function adopt(next) {
    if (next === null) return false;
    const cur = model();
    if (cur !== null && cur.equals(next)) return true;
    const pos = ball.physicsPosition();
    const phys = ball.physics();
    if (phys !== null && cur !== null) {
        try { phys.removeRigidBodyFromModel_(new ObjC.Object(cur)); } catch (err) { /* */ }
    }
    mem.global('ball').writePointer(next);
    if (pos !== null) ball.place(next, pos.x, pos.y, pos.z);
    if (phys !== null) {
        try { phys.addRigidBodyFromModel_(new ObjC.Object(next)); } catch (err) { /* */ }
    }
    return true;
}

function rawPtr(v) {
    if (v === null || v === undefined) return NULL;
    if (v.handle !== undefined) return v.handle;
    return ptr(v);
}

function grabVisual(node) {
    const o = new ObjC.Object(node);
    let nFrames = 1;
    try { nFrames = Number(o.numVertexAnimFrames()); } catch (err) { /* */ }
    return {
        meshes: o.modelMeshes(),
        mats: o.modelMaterials(),
        nSub: Number(o.numOfSubMeshes()),
        nTotal: Number(o.totalNumOfMeshes()),
        nFrames,
    };
}

function applyVisual(node, vis) {
    const o = new ObjC.Object(node);
    try { o.setModelMeshes_(vis.meshes); } catch (err) {
        o.setModelMeshes_(rawPtr(vis.meshes));
    }
    try { o.setModelMaterials_(vis.mats); } catch (err) {
        o.setModelMaterials_(rawPtr(vis.mats));
    }
    o.setNumOfSubMeshes_(vis.nSub);
    o.setTotalNumOfMeshes_(vis.nTotal);
    try { o.setNumVertexAnimFrames_(vis.nFrames); } catch (err) { /* */ }
}

function restoreVisual() {
    if (state.visual === null) return;
    try { applyVisual(state.visual.ptr, state.visual.orig); } catch (err) { /* */ }
    state.visual = null;
}

function logUvRange(node) {
    try {
        const o = new ObjC.Object(node);
        const meshes = rawPtr(o.modelMeshes());
        if (meshes.isNull()) {
            log.info('skin tennis uv1: no meshes', 'skin');
            return;
        }
        const mesh = new ObjC.Object(meshes.readPointer());
        const uv = mesh.uv1();
        const nv = Number(mesh.numVerts());
        if (uv === null || ptr(uv).isNull() || nv < 1) {
            log.info(`skin tennis uv1 missing verts=${nv}`, 'skin');
            return;
        }
        const p = ptr(uv);
        let minU = 1e9;
        let maxU = -1e9;
        let minV = 1e9;
        let maxV = -1e9;
        const step = Math.max(1, (nv / 64) | 0);
        for (let i = 0; i < nv; i += step) {
            const u = p.add(i * 8).readFloat();
            const v = p.add(i * 8 + 4).readFloat();
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        log.info(
            `skin tennis uv1 u=${minU.toFixed(2)}..${maxU.toFixed(2)}`
            + ` v=${minV.toFixed(2)}..${maxV.toFixed(2)} verts=${nv}`,
            'skin');
    } catch (err) {
        log.info(`skin uv1: ${err.message}`, 'skin');
    }
}

function clearEnvUv(node) {
    try {
        const off = ivars.offsetOf('synModel', 'envUv');
        ptr(node).add(off).writePointer(NULL);
    } catch (err) { /* */ }
}

function borrowVisualFrom(live, src) {
    if (src === null) return false;
    const liveObj = new ObjC.Object(live);
    const srcObj = new ObjC.Object(src);
    if (liveObj.equals(srcObj)) return true;
    try {
        const liveMeshes = rawPtr(liveObj.modelMeshes());
        const srcMeshes = rawPtr(srcObj.modelMeshes());
        if (!liveMeshes.isNull() && liveMeshes.equals(srcMeshes)) {
            if (state.visual === null) {
                state.visual = { ptr: live, orig: grabVisual(live) };
            }
            return true;
        }
    } catch (err) { /* */ }
    if (state.visual === null) {
        state.visual = { ptr: live, orig: grabVisual(live) };
    }
    applyVisual(live, grabVisual(src));
    clearEnvUv(live);
    return true;
}

function borrowSphereVisual(live) {
    return borrowVisualFrom(live, pickSphere());
}

// Gold: the smooth sphere's meshes (HeroBall03) wearing HeroBall05's own
// materials. HeroBall05 is three layers: HeroBallA_Gld (a flat 16x16 gold
// swatch), the sky reflection, and HeroBallA_Gld_Glow - the orange strips
// (same layout as HeroBallA's cyan ones). Only the glow layer is dropped.
function borrowGoldVisual(live) {
    const sphere = pickSphere();
    const gold = pickBall(5);
    if (sphere === null || gold === null) return false;
    const vis = grabVisual(sphere);
    const look = grabVisual(gold);
    vis.mats = look.mats;
    if (look.nSub < vis.nSub) {
        vis.nSub = look.nSub;
        vis.nTotal = vis.nSub * Math.max(1, vis.nFrames);
    }
    if (state.visual === null) {
        state.visual = { ptr: live, orig: grabVisual(live) };
    }
    applyVisual(live, vis);
    clearEnvUv(live);
    return true;
}

// HeroBallA_Gld is one flat colour, (141, 101, 16) - a dull, dark gold. The
// sky reflection sits on top of it, so a brighter, more saturated swatch
// makes the ball golder without touching the reflection layer.
const GOLD_RGB = [255, 194, 0];

function goldSwatch() {
    if (state.goldId) return state.goldId;
    const n = 4;
    const buf = Memory.alloc(n * n * 4);
    for (let i = 0; i < n * n; i++) {
        buf.add(i * 4).writeU8(GOLD_RGB[0]);
        buf.add(i * 4 + 1).writeU8(GOLD_RGB[1]);
        buf.add(i * 4 + 2).writeU8(GOLD_RGB[2]);
        buf.add(i * 4 + 3).writeU8(255);
    }
    state.goldId = upload({ w: n, h: n, buf }, 0);
    return state.goldId;
}

function brightenGold(slots) {
    const base = slots.filter(sl => /_Gld\.png$/i.test(textureNameOf(sl.tex)));
    if (base.length === 0) return 0;
    const id = goldSwatch();
    base.forEach(sl => {
        try { sl.tex.setTextureId_(id); } catch (err) { /* */ }
    });
    return base.length;
}

// textureId 0 makes synMaterial skip that map (renderer: textureId == 0 ->
// next layer), so the strips vanish and the gold base + reflection remain.
function dropGlow(slots) {
    const names = slots.map(sl => `${textureNameOf(sl.tex) || sl.id}(uv ${sl.uv | 0})`);
    const glow = slots.filter(sl => /glow/i.test(textureNameOf(sl.tex)));
    glow.forEach(sl => {
        try { sl.tex.setTextureId_(0); } catch (err) { /* */ }
    });
    log.debug(`gold layers: ${names.join(', ')}  dropped ${glow.length} glow`, 'skin');
    return glow.length;
}

function materialHasTendril(mat) {
    try {
        if ((Number(mat.shouldLoopAnim()) | 0) !== 0) return true;
    } catch (err) { /* */ }
    let maps = 1;
    try { maps = Number(mat.numOfMaps()); } catch (err) { /* */ }
    let texs;
    try { texs = mat.textures(); } catch (err) { return false; }
    for (let j = 0; j < maps; j++) {
        try {
            let tex = null;
            if (texs && typeof texs.count === 'function') {
                if (j >= texs.count()) break;
                tex = texs.objectAtIndex_(j);
            } else {
                const tp = ptr(texs).add(j * Process.pointerSize).readPointer();
                if (tp.isNull()) continue;
                tex = new ObjC.Object(tp);
            }
            if (tex !== null && /tendril/i.test(textureNameOf(tex))) return true;
        } catch (err) { /* */ }
    }
    return false;
}

function shellVisualFrom(src) {
    const o = new ObjC.Object(src);
    let n = 0;
    try { n = Number(o.numOfSubMeshes()); } catch (err) { return null; }
    const meshes = rawPtr(o.modelMeshes());
    const mats = rawPtr(o.modelMaterials());
    if (meshes.isNull() || mats.isNull()) return null;
    const keepMesh = [];
    const keepMat = [];
    for (let i = 0; i < n; i++) {
        const mp = meshes.add(i * Process.pointerSize).readPointer();
        const tp = mats.add(i * Process.pointerSize).readPointer();
        if (tp.isNull()) continue;
        try {
            if (materialHasTendril(new ObjC.Object(tp))) continue;
        } catch (err) { continue; }
        keepMesh.push(mp);
        keepMat.push(tp);
    }
    if (keepMesh.length === 0) return null;
    const meshArr = Memory.alloc(keepMesh.length * Process.pointerSize);
    const matArr = Memory.alloc(keepMat.length * Process.pointerSize);
    for (let i = 0; i < keepMesh.length; i++) {
        meshArr.add(i * Process.pointerSize).writePointer(keepMesh[i]);
        matArr.add(i * Process.pointerSize).writePointer(keepMat[i]);
    }
    state.shellBuf = [meshArr, matArr];
    return {
        meshes: meshArr,
        mats: matArr,
        nSub: keepMesh.length,
        nTotal: keepMesh.length,
        nFrames: 1,
    };
}

function borrowGlassShell(live) {
    const plasma = pickPlasma();
    if (plasma === null) return false;
    const vis = shellVisualFrom(plasma);
    if (vis === null) return false;
    if (state.visual === null) {
        state.visual = { ptr: live, orig: grabVisual(live) };
    }
    applyVisual(live, vis);
    clearEnvUv(live);
    try { new ObjC.Object(live).setNumVertexAnimFrames_(1); } catch (err) { /* */ }
    return true;
}

function isEnvSlot(s) {
    const uv = s.uv | 0;
    return !!(s.sky || uv < 0 || uv === 255 || uv === 254);
}

function isAlbedoSlot(s) {
    return (s.uv | 0) === 1;
}

function fitAlbedo(tex) {
    // 1 = mesh uv1. 0 disables texcoords and every pixel samples one texel.
    try { tex.setUvCoords_(1); } catch (err) { /* */ }
    try { tex.setViewAlignedReflections_(0); } catch (err) { /* */ }
    try { tex.setGenMipmapsAtUpload_(0); } catch (err) { /* */ }
    try { tex.setLod_bias_(0); } catch (err) { /* */ }
    try { tex.setUTile_(1); } catch (err) { /* */ }
    try { tex.setVTile_(1); } catch (err) { /* */ }
    try { tex.setUOffset_(0); } catch (err) { /* */ }
    try { tex.setVOffset_(0); } catch (err) { /* */ }
    // 1 = GL_REPEAT so the 2:1 wrap meets at the back of the sphere.
    try { tex.setTextureTileOrMirrorU_(1); } catch (err) { /* */ }
    try { tex.setTextureTileOrMirrorV_(1); } catch (err) { /* */ }
}

function hideEnv(s) {
    try { s.tex.setTextureId_(0); } catch (err) { /* */ }
    try { s.tex.setViewAlignedReflections_(0); } catch (err) { /* */ }
}

function slotName(s) {
    return textureNameOf(s.tex) || '';
}

function applyGlassLook(slots) {
    const keep = [];
    const hide = [];
    const skyLive = liveSkyId();
    slots.forEach(s => {
        const name = slotName(s);
        try { s.mat.setShouldLoopAnim_(0); } catch (err) { /* */ }
        if (/tendril/i.test(name)) {
            hide.push(name);
            try { s.tex.setTextureId_(0); } catch (err) { /* */ }
            try { s.mat.setMeshAlpha_(0); } catch (err) { /* */ }
            try { s.mat.setIsTransparent_(1); } catch (err) { /* */ }
            return;
        }
        keep.push(name || `uv${s.uv | 0}`);
        try { s.mat.setIsTransparent_(1); } catch (err) { /* */ }
        try { s.mat.setTransparencyType_(3); } catch (err) { /* */ }
        const env = /skydome|falloff|darkenreflect/i.test(name)
            || s.sky || (s.uv | 0) < 0;
        if (env) {
            // Live sky RTT on both shell maps is ~2-3x the baked SkyDomeA_
            // reflection, without going full chrome (shell stays transparent).
            if (skyLive) {
                try { s.tex.setTextureId_(skyLive); } catch (err) { /* */ }
            }
            try { s.tex.setUvCoords_(-1); } catch (err) { /* */ }
            try { s.tex.setViewAlignedReflections_(1); } catch (err) { /* */ }
        }
    });
    return { keep, hide, sky: skyLive | 0 };
}

function skinsDir() {
    const root = storage.directory();
    if (root === null) return null;
    const dir = `${root}/skins`;
    try {
        ObjC.classes.NSFileManager.defaultManager()
            .createDirectoryAtPath_withIntermediateDirectories_attributes_error_(
                dir, true, NULL, NULL);
    } catch (err) {
        return null;
    }
    return dir;
}

function defaultKeys(kind) {
    if (kind === 'flag') {
        const id = achievements.state.flag || 'us';
        return [`flag-${id}`, 'flag'];
    }
    if (kind === 'eyeball') return ['Eye', 'eye', 'eyeball'];
    return [kind];
}

function userSkinPath(kind) {
    const dir = skinsDir();
    if (dir === null) return null;
    const fm = ObjC.classes.NSFileManager.defaultManager();
    const keys = defaultKeys(kind);
    const exts = ['jpg', 'jpeg', 'png', 'bmp'];
    for (let i = 0; i < keys.length; i++) {
        for (let e = 0; e < exts.length; e++) {
            const path = `${dir}/${keys[i]}.${exts[e]}`;
            if (fm.fileExistsAtPath_(path)) return path;
        }
    }
    return null;
}

function seedKey(key) {
    const dir = skinsDir();
    if (dir === null || !defaults[key]) return null;
    const jpeg = String(defaults[key]).indexOf('/9j/') === 0;
    const ext = jpeg ? 'jpg' : 'png';
    const path = `${dir}/${key}.${ext}`;
    const fm = ObjC.classes.NSFileManager.defaultManager();
    const ns = ObjC.classes.NSString.stringWithString_(defaults[key]);
    const data = ObjC.classes.NSData.alloc().initWithBase64EncodedString_options_(ns, 0);
    defaults[key] = '';
    if (data === null) return null;
    if (fm.fileExistsAtPath_(path)) {
        let same = false;
        try {
            const existing = ObjC.classes.NSData.dataWithContentsOfFile_(path);
            same = existing !== null && existing.isEqualToData_(data);
        } catch (err) { same = false; }
        if (same) return path;
        try { fm.removeItemAtPath_error_(path, NULL); } catch (err) { /* */ }
    }
    if (!data.writeToFile_atomically_(path, true)) return null;
    if (jpeg) {
        try { fm.removeItemAtPath_error_(`${dir}/${key}.png`, NULL); } catch (err) { /* */ }
    }
    return path;
}

function seedDefaultPng(kind) {
    const keys = defaultKeys(kind);
    for (let i = 0; i < keys.length; i++) {
        const path = seedKey(keys[i]);
        if (path !== null) return path;
    }
    return userSkinPath(kind);
}

function uploadUserFile(path, existingId) {
    makeCurrent();
    const pixels = pixelsFromFile(path);
    return { id: upload(pixels, existingId || state.glId), w: pixels.w, h: pixels.h };
}

function ballKeyOf(modelObj) {
    return modelObj === null ? null : modelObj.toString();
}

function officialPlayer() {
    try {
        const idx = mem.global('ballIndex').readS32();
        return pickBall(idx);
    } catch (err) {
        return null;
    }
}

function adoptHomeIfSwapped() {
    const official = officialPlayer();
    const cur = model();
    if (official === null || cur === null) return false;
    try {
        if (cur.equals(official)) return false;
    } catch (err) { return false; }
    adopt(official);
    state.backup = null;
    state.ballKey = null;
    log.info('skin put official player body back', 'skin');
    return true;
}

function slotUvSummary(slots) {
    return slots.map(s => {
        const uv = s.uv | 0;
        const name = textureNameOf(s.tex) || '?';
        return `${name}:uv${uv}`;
    }).join(',');
}

function applyKind(kind) {
    state.lastError = null;
    try {
        if ((mem.global('flashState').readU8() | 0) !== 0) {
            return { ok: false, reason: 'queued' };
        }
    } catch (err) { /* */ }
    adoptHomeIfSwapped();
    let m = model();
    if (m === null) return { ok: false, reason: 'no ball in play' };
    if (kind !== 'stock' && !achievements.skinUnlocked(kind)) {
        return { ok: false, reason: 'locked' };
    }

    if (kind === 'stock') {
        if (state.backup !== null) restoreSlots(state.backup);
        restoreVisual();
        adoptHomeIfSwapped();
        state.applied = null;
        state.home = null;
        state.backup = null;
        state.ballKey = null;
        return { ok: true, kind: 'stock' };
    }

    if (state.home === null) state.home = m;

    let wrap = null;
    if (kind !== 'glass' && kind !== 'mirror' && kind !== 'gold') {
        try {
            wrap = loadWrap(kind);
        } catch (err) {
            state.lastError = err.message;
            if (/id 0|EAGL|GOT empty|not current/i.test(err.message)) {
                return { ok: false, reason: 'queued' };
            }
            log.info(`skin upload: ${err.message}`, 'skin');
            return { ok: false, reason: 'upload' };
        }
        if (!wrap || !wrap.id) {
            return { ok: false, reason: 'queued' };
        }
        takeWrapId(wrap.id);
    }

    if (state.backup !== null) restoreSlots(state.backup);
    state.parked = false;
    restoreVisual();
    state.backup = null;
    m = model();
    if (m === null) return { ok: false, reason: 'no ball in play' };

    const chrome = kind === 'mirror' ? captureChrome() : null;
    if (kind === 'gold') {
        if (!borrowGoldVisual(m)) {
            state.lastError = 'no HeroBall03/05 to borrow';
            return { ok: false, reason: 'queued' };
        }
    } else if (kind === 'glass') {
        if (!borrowGlassShell(m)) {
            log.info('skin glass: no shell meshes, using tennis', 'skin');
            borrowSphereVisual(m);
        }
    } else {
        borrowSphereVisual(m);
    }
    m = model();
    if (m === null) return { ok: false, reason: 'no ball in play' };

    state.backup = snapshot(m);
    state.ballKey = ballKeyOf(m);
    const slots = snapshot(m);
    if (slots.length === 0) return { ok: false, reason: 'ball has no textures' };

    if (kind === 'mirror') {
        applyFullChrome(slots, chrome);
        state.applied = kind;
        log.info('skin mirror', 'skin');
        return { ok: true, kind };
    }

    if (kind === 'gold') {
        dropGlow(slots);
        const n = brightenGold(slots);
        log.debug(`gold: ${n} base layer(s) -> ${GOLD_RGB.join(',')}`, 'skin');
        state.applied = kind;
        return { ok: true, kind };
    }

    if (kind === 'glass') {
        const g = applyGlassLook(slots);
        state.applied = kind;
        log.info(`skin glass keep ${g.keep.join(',') || 'none'}`
            + ` hide ${g.hide.join(',') || 'none'} sky=${g.sky || 0}`, 'skin');
        return { ok: true, kind };
    }

    const id = state.glId;
    let paintTarget = slots.filter(isAlbedoSlot);
    if (paintTarget.length === 0) paintTarget = slots.filter(s => !isEnvSlot(s));
    if (paintTarget.length === 0 && slots.length > 0) paintTarget = [slots[0]];
    paintTarget.forEach(s => {
        try { s.tex.setTextureId_(id); } catch (err) { /* */ }
        fitAlbedo(s.tex);
    });
    try { finishGlTexture(id); } catch (err) { /* */ }
    slots.forEach(s => {
        if (isEnvSlot(s)) hideEnv(s);
    });
    const sizeTxt = wrap && wrap.w ? ` ${wrap.w}x${wrap.h}` : '';
    log.info(`skin ${kind}${kind === 'flag' ? '-' + (achievements.state.flag || '') : ''}${sizeTxt} id=${id}`, 'skin');
    state.applied = kind;
    state.paint = null;
    state.held = [];
    log.info(`skin ${kind} on GL id=${id}, cpu copy dropped, hook idle`, 'mem');
    return { ok: true, kind };
}

function tellUi(msg) {
    try { require('../ui/panel').setStatus(msg); } catch (err) { /* */ }
    try { require('../ui/panel').ui.skinStamp = ''; } catch (err) { /* */ }
}

function apply(kind) {
    try {
        if (!require('../core/budget').skinsOn()) {
            log.info('skin apply blocked - SKIN APPLY is off', 'mem');
            return { ok: false, reason: 'skins off' };
        }
    } catch (err) { /* */ }
    state.pending = kind;
    state.tries = 0;
    state.failLogged = false;
    try { require('../game/frame').syncHot(); } catch (err) { /* */ }
    return { ok: true, kind, queued: true };
}

function restore() {
    state.parked = false;
    if (state.backup !== null) restoreSlots(state.backup);
    restoreVisual();
    adoptHomeIfSwapped();
    state.applied = null;
    state.backup = null;
    state.ballKey = null;
    state.pending = null;
    state.home = null;
    log.info('restored original ball skin', 'skin');
    tellUi('stock ball');
    return true;
}

function onFrame() {
    const want = state.pending;
    if (want === null) return;
    try {
        if (require('./macro').hooksQuiet()) return;
    } catch (err) { /* */ }
    const now = Date.now();
    if (now - state.lastTry < 250) return;
    state.lastTry = now;
    try {
        const r = applyKind(want);
        if (r.ok) {
            state.pending = null;
            tellUi(want === 'stock' ? 'stock ball' : want);
        } else if (r.reason === 'queued' || r.reason === 'no ball in play') {
            state.tries += 1;
            if (state.tries > 24) {
                state.pending = null;
                tellUi(state.lastError || 'skin timed out');
            }
        } else {
            state.pending = null;
            tellUi(r.reason === 'locked' ? `${want} is locked` : (r.reason || 'failed'));
            if (r.reason === 'locked') {
                log.info(`skin ${want} is locked`, 'skin');
            }
        }
    } catch (err) {
        state.pending = null;
        tellUi(err.message || 'failed');
        if (!state.failLogged) {
            log.info(`skin apply: ${err.message}`, 'skin');
            state.failLogged = true;
        }
    }
}

function install() {
    if (state.installed) return true;
    frame.onAfterFrame(log.guard('skins.onFrame', onFrame), 'skin');
    frame.onAfterRender(log.guard('skins.onRender', function () {
        if (state.pending === null) return;
        if (!frame.state.paused) return;
        onFrame();
    }), 'skin');
    try { sweepJunk(); } catch (err) { /* */ }
    ['glass', 'comet', 'golf', 'galaxy', 'clock', 'neon', 'globe', 'eyeball'].forEach(k => {
        try { seedDefaultPng(k); } catch (err) { /* */ }
    });
    FLAGS.forEach(f => {
        try { seedKey(`flag-${f.id}`); } catch (err) { /* */ }
    });
    try { sweepJunk(); } catch (err) { /* */ }
    state.installed = true;
    return true;
}

function flagTitle() {
    const id = achievements.state.flag;
    for (let i = 0; i < FLAGS.length; i++) {
        if (FLAGS[i].id === id) return FLAGS[i].title;
    }
    return id;
}

function cycleFlag() {
    const cur = achievements.state.flag;
    let i = 0;
    for (; i < FLAGS.length; i++) {
        if (FLAGS[i].id === cur) break;
    }
    const next = FLAGS[(i + 1) % FLAGS.length];
    achievements.setFlag(next.id);
    state.paint = null;
    if (state.applied === 'flag') apply('flag');
    return next;
}

module.exports = {
    menuGuard,
    state, FLAGS, install, apply, restore, cycleFlag, flagTitle,
    previewImage, swatch, paintFor, skinsDir,
};
