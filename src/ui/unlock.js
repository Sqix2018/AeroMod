// Banner when a hidden TAS skin unlocks. Card only - no full-screen veil.

const theme = require('./theme');
const w = require('./widgets');

const ui = { card: null, timer: null };

function flash(def) {
    ObjC.schedule(ObjC.mainQueue, function () {
        hide();
        const window = w.uiRoot();
        if (window === null || def === null) return;

        const bounds = window.bounds();
        const width = Math.min(360, bounds[1][0] - 40);
        const height = 150;
        const x = (bounds[1][0] - width) / 2;
        const y = (bounds[1][1] - height) / 2;

        const card = w.view([[x, y], [width, height]],
            ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(0.06, 0.08, 0.10, 0.94));
        card.setUserInteractionEnabled_(true);
        card.addSubview_(w.label([[12, 14], [width - 56, 22]], def.title, {
            size: 13, color: theme.accent, center: true,
        }));
        card.addSubview_(w.button([[width - 40, 8], [32, 32]], '\u2715', hide, {
            size: 15, background: theme.surfaceAlt,
        }));
        card.addSubview_(w.label([[12, 40], [width - 24, 28]],
            def.ball ? `Unlocked ${def.ball}` : 'UNLOCKED', {
            size: 22, color: theme.text, center: true,
        }));
        card.addSubview_(w.label([[16, 76], [width - 32, 58]], def.desc, {
            size: 13, color: theme.textDim, center: true, lines: 3,
        }));
        window.addSubview_(card);
        ui.card = card;
        try { require('./power').register(card); } catch (err) { /* */ }
        ui.timer = setTimeout(hide, 8000);
    });
}

function hide() {
    if (ui.timer !== null) {
        clearTimeout(ui.timer);
        ui.timer = null;
    }
    if (ui.card !== null) {
        try { ui.card.removeFromSuperview(); } catch (err) { /* */ }
        ui.card = null;
    }
}

module.exports = { flash, hide, ui };
