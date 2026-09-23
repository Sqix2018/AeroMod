// Shared colours and metrics. Touch targets are >= 44pt per Apple's guidance,
// which matters here because you are hitting them one-handed on an iPad.

function rgba(r, g, b, a) {
    return ObjC.classes.UIColor.colorWithRed_green_blue_alpha_(r, g, b, a);
}

const theme = {
    TOUCH: 44,
    gap: 8,
    corner: 10,
    panel: { width: 460, height: 448 },
};

// Colours and fonts are lazy: UIColor/UIFont do not exist until ObjC is up.
Object.defineProperties(theme, {
    background: { get: () => rgba(0.06, 0.07, 0.09, 0.94) },
    surface: { get: () => rgba(0.14, 0.15, 0.18, 1.0) },
    surfaceAlt: { get: () => rgba(0.22, 0.23, 0.27, 1.0) },
    accent: { get: () => rgba(0.20, 0.80, 0.42, 1.0) },
    accentDim: { get: () => rgba(0.13, 0.40, 0.25, 1.0) },
    danger: { get: () => rgba(0.85, 0.30, 0.30, 1.0) },
    text: { get: () => ObjC.classes.UIColor.whiteColor() },
    textDim: { get: () => rgba(0.65, 0.68, 0.74, 1.0) },
    monoFont: { get: () => ObjC.classes.UIFont.monospacedDigitSystemFontOfSize_weight_(13, 0) },
});

module.exports = theme;
