# -*- coding: utf-8 -*-
"""
NarrowbandProcessing for Siril - version 1.2 (November 2026)

Stretching and blending of narrowband line images (Ha, OIII and optional SII)
into color images, with a live preview. Siril port of the PixInsight script
NarrowbandProcessing 1.0.

Stretch
 - Black point per line from the real sky (robust background and noise
   estimates) instead of the single darkest pixel, with a clipping guard for
   nebulae that fill the frame.
 - Midtone stretch to a target median; line linking from independent (equal
   medians) to fully linked (true relative brightness).
 - Neutral background, contrast S-curve and highlight protection (arcsinh
   blend for bright cores such as M42).

Blend
 - Foraxx (dynamic) HOO / SHO, ratio color (with presets, automatic balance
   and color smoothing), classic palettes with editable weights, and custom
   expressions.
 - Saturation, green reduction (SCNR-style) and Foraxx finishing (hue and
   saturation curves; curve settings from Paul Hancock's ForaxxPalette
   utility for PixInsight, applied here in HSV space).

Requires Siril 1.4 or newer (Python scripting). Uses numpy, scipy and PyQt6,
which are installed automatically on first run if missing.

Author: Justin Pickens
Contact / bug reports: https://github.com/justinthedark/NarrowbandProcessing/issues
Home page: https://github.com/justinthedark/NarrowbandProcessing

Version history
 1.0    First release (tkinter window).
 1.0.1  Dark theme fix for macOS.
 1.1    Window rebuilt with PyQt6 (Siril's recommended toolkit); author and
        contact details shown in the window; checks for Siril 1.4.
 1.2    Sharper preview: computed at the screen's real resolution (Retina /
        HiDPI aware), 100% (1:1) zoom with panning, Sharp / Balanced / Fast quality.
        American spelling (color, center, gray).

Copyright (C) 2026 Justin Pickens

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <http://www.gnu.org/licenses/>.
"""

import math
import os
import re
import sys

VERSION = "1.2"
TITLE = "NarrowbandProcessing"

L_HA, L_OIII, L_SII = 0, 1, 2
LINE_NAMES = ["Ha", "OIII", "SII"]
LINE_OUTPUT_NAMES = ["_HA_s", "_OIII_s", "_SII_s"]

BLEND_FORAXX, BLEND_RATIO, BLEND_PALETTE, BLEND_CUSTOM = 0, 1, 2, 3
BLEND_NAMES = ["Foraxx (dynamic)", "Ratio color", "Classic palette", "Custom expressions"]
BLEND_TAGS = ["Foraxx", "Ratio", "Palette", "Custom"]

RATIO_PRESETS = [
    {"name": "Gold + blue core", "ha": [1.00, 0.70, 0.28], "oiii": [0.30, 0.62, 1.00]},
    {"name": "Copper + teal",    "ha": [1.00, 0.48, 0.22], "oiii": [0.20, 0.78, 0.80]},
    {"name": "Red + cyan",       "ha": [1.00, 0.22, 0.16], "oiii": [0.25, 0.90, 1.00]},
    {"name": "Amber + blue",     "ha": [1.00, 0.60, 0.10], "oiii": [0.15, 0.45, 1.00]},
]
RATIO_SII_COLOUR = [1.00, 0.30, 0.18]

# Classic palettes: rows R, G, B; columns H, O, S
PALETTES = [
    {"name": "HOO", "w": [[1, 0, 0], [0, 1, 0], [0, 1, 0]]},
    {"name": "HOO (green from Ha + OIII)", "w": [[1, 0, 0], [0.4, 0.6, 0], [0, 1, 0]]},
    {"name": "SHO", "w": [[0, 0, 1], [1, 0, 0], [0, 1, 0]]},
    {"name": "HSO", "w": [[1, 0, 0], [0, 0, 1], [0, 1, 0]]},
    {"name": "HOS", "w": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
]

# Foraxx finishing curves (settings from Paul Hancock's ForaxxPalette utility)
FORAXX_HUE_1 = [[0.00000, 0.00000], [0.02517, 0.05952], [0.07323, 0.08571], [0.11442, 0.13810], [0.62014, 0.67619], [1.00000, 1.00000]]
FORAXX_SAT_1 = [[0.00000, 0.00000], [0.50801, 0.61667], [1.00000, 1.00000]]
FORAXX_HUE_2 = [[0.00000, 0.00000], [0.05034, 0.03571], [0.08238, 0.10238], [0.24943, 0.25000], [1.00000, 1.00000]]
FORAXX_HUE_SAT = [[0.00000, 0.00000], [0.04910, 0.00909], [0.07235, 0.00909], [0.10594, 0.15455], [0.19380, 0.00909],
                  [0.37726, 0.00000], [0.52972, 0.00909], [0.60465, 0.13636], [0.68475, -0.00909], [0.84496, 0.00000],
                  [1.00000, 0.00000]]

PREVIEW_SIZE = 640

# numpy / scipy are imported lazily (after Siril has had a chance to install them)
np = None
ndimage = None
Akima1DInterpolator = None


def import_numeric():
    global np, ndimage, Akima1DInterpolator
    if np is None:
        import numpy as _np
        np = _np
    if ndimage is None:
        try:
            from scipy import ndimage as _nd
            from scipy.interpolate import Akima1DInterpolator as _ak
            ndimage = _nd
            Akima1DInterpolator = _ak
        except Exception:
            ndimage = False
            Akima1DInterpolator = False


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def default_settings():
    return {
        "shadowClip": 3.0,
        "targetMedian": 0.25,
        "link": 0.0,             # Foraxx (the default blend) expects equal medians
        "neutralBackground": True,
        "contrast": 40.0,
        "highlightProtection": 0.0,
        "blendMode": BLEND_FORAXX,
        "ratioPreset": 0,
        "ratioBalance": 0.0,
        "ratioContrast": 3.0,
        "siiStrength": 1.0,
        "ratioBrightness": 1.4,
        "colorSmoothing": 2.0,
        "paletteIndex": 0,
        "paletteWeights": [row[:] for row in PALETTES[0]["w"]],
        "customR": "H",
        "customG": "0.5*H + 0.5*O",
        "customB": "O",
        "saturation": 1.0,
        "greenReduction": 0.0,
        "foraxxFinishing": True,
        "keepMono": False,
    }


def apply_mode_defaults(s):
    """Sensible link / finishing values when the blend mode changes."""
    if s["blendMode"] == BLEND_FORAXX:
        s["link"], s["foraxxFinishing"] = 0.0, True
    elif s["blendMode"] == BLEND_RATIO:
        s["link"], s["foraxxFinishing"] = 75.0, False
    elif s["blendMode"] == BLEND_PALETTE:
        s["link"], s["foraxxFinishing"] = 0.0, False


def reset_sliders(s):
    """Every slider back to its default for the current mode; keeps images, mode, preset and expressions."""
    d = default_settings()
    for k in ["shadowClip", "targetMedian", "contrast", "highlightProtection", "neutralBackground", "ratioBalance",
              "ratioContrast", "siiStrength", "ratioBrightness", "colorSmoothing", "saturation", "greenReduction"]:
        s[k] = d[k]
    pi = s["paletteIndex"] if 0 <= s["paletteIndex"] < len(PALETTES) else 0
    s["paletteWeights"] = [row[:] for row in PALETTES[pi]["w"]]
    apply_mode_defaults(s)


# ---------------------------------------------------------------------------
# Robust statistics (same method as the PixInsight version)
# ---------------------------------------------------------------------------

def inner(img):
    """The image without a 3% border, where registration leaves partial data."""
    h, w = img.shape
    mx, my = int(w * 0.03), int(h * 0.03)
    return img[my:h - my, mx:w - mx]


def clipped_stats(values, lo, hi):
    v = values[(values > lo) & (values < hi)]
    if v.size == 0:
        return 0.0, 0.0
    med = float(np.median(v))
    sigma = 1.4826 * float(np.median(np.abs(v - med)))
    return med, sigma


def difference_noise(img):
    """Noise from differences between pixels two columns apart (immune to smooth nebulosity)."""
    h, w = img.shape
    step = max(1, h // 400)
    rows = img[::step]
    a = rows[:, 0:w - 2:3]
    b = rows[:, 2:w:3]
    n = min(a.shape[1], b.shape[1])
    a, b = a[:, :n], b[:, :n]
    ok = (a > 1e-7) & (b > 1e-7) & (a < 0.9) & (b < 0.9)
    d = np.abs(a - b)[ok]
    if d.size < 100:
        return 0.0
    return float(np.median(d)) / (0.6745 * math.sqrt(2.0))


def robust_background(img):
    """Sky level from the faintest pixels; noise from pixel differences."""
    lo = 1e-7
    sigma = difference_noise(img)
    vals = inner(img).ravel()
    q = clipped_stats(vals, lo, 1.0)[0]
    for _ in range(4):
        q = clipped_stats(vals, lo, q)[0]
    if not sigma > 1e-9:
        med, s = clipped_stats(vals, lo, 1.0)
        return med, max(s, 1e-9)
    return q + 1.8627 * sigma, sigma


def sorted_sample(img):
    h, w = img.shape
    step = max(1, int(math.floor(math.sqrt(w * h / 250000.0))))
    v = inner(img)[::step, ::step].ravel()
    v = v[v > 1e-7]
    return np.sort(v)


def normal_tail(k):
    x = k / math.sqrt(2.0)
    t = 1 / (1 + 0.3275911 * x)
    erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * math.exp(-x * x)
    return 0.5 * erfc


def sample_at(sample, p):
    if sample.size == 0:
        return 0.0
    return float(sample[min(sample.size - 1, max(0, int(math.floor(p * sample.size))))])


def fraction_below(sample, value):
    if sample.size == 0:
        return 0.0
    return float(np.searchsorted(sample, value, side="right")) / sample.size


_MEASURE_CACHE = {}


def clear_measure_cache():
    _MEASURE_CACHE.clear()


def measure_line(key, img):
    """Sky, noise, median and a sorted sample; measured once per image."""
    if key in _MEASURE_CACHE:
        return _MEASURE_CACHE[key]
    sky, sigma = robust_background(img)
    med = clipped_stats(inner(img).ravel(), 1e-7, 1.0)[0]
    m = {"sky": sky, "sigma": sigma, "median": med, "sample": sorted_sample(img)}
    _MEASURE_CACHE[key] = m
    return m


# ---------------------------------------------------------------------------
# Stretch engine
# ---------------------------------------------------------------------------

def midtones_for(x0, target):
    x0 = max(1e-9, min(0.999999, x0))
    return x0 * (1 - target) / (x0 + target - 2 * target * x0)


def mtf(x, m):
    """Midtone transfer function on numbers or arrays (x in [0, 1])."""
    return (m - 1) * x / ((2 * m - 1) * x - m)


def contrast_gamma(s):
    return 1 + max(0.0, min(100.0, s["contrast"])) / 100.0


def contrast_gamma_high(s, w):
    return 1 + (contrast_gamma(s) - 1) * (1 - w)


def arcsinh_softening(x0, T, X):
    x0 = max(1e-9, x0)
    if x0 / X >= T:
        return 1e6
    lo, hi = math.log(1e-12), math.log(1e6)
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        b = math.exp(mid)
        r = math.asinh(x0 / b) / math.asinh(X / b)
        if r < T:
            hi = mid
        else:
            lo = mid
    return math.exp(0.5 * (lo + hi))


def analyze_lines(lines, s):
    """lines: list of (line, key, img). Black point and reference brightness per line."""
    info = []
    for line, key, img in lines:
        m = measure_line(key, img)
        bp = max(0.0, m["sky"] - s["shadowClip"] * m["sigma"])
        # Clipping guard: allow about twice the clipping pure sky noise would give (at least 0.05%)
        allowed = max(0.0005, 2 * normal_tail(s["shadowClip"]))
        floor_value = sample_at(m["sample"], allowed)
        guarded = False
        if floor_value > 0 and bp > floor_value:
            bp, guarded = floor_value, True
        x0 = (m["median"] - bp) / (1 - bp)
        if not x0 > 0:
            x0 = max(1e-6, (m["sigma"] * s["shadowClip"]) / (1 - bp))
        info.append({"line": line, "key": key, "sky": m["sky"], "sigma": m["sigma"], "bp": bp, "median": m["median"],
                     "x0": x0, "guarded": guarded, "floorValue": floor_value, "sample": m["sample"]})
    return info


def stretch_parameters(info, s):
    ref = info[0]   # Ha is always first
    m = midtones_for(ref["x0"], s["targetMedian"])
    link = max(0.0, min(1.0, s["link"] / 100.0))
    for p in info:
        p["gain"] = (ref["x0"] / p["x0"]) ** (1 - link)
        p["m"] = m

    # Neutral background: every line's sky lands at the same stretched level as Ha's
    if s["neutralBackground"]:
        use_floor = ref["guarded"]
        ref_anchor = ref["floorValue"] if use_floor else ref["sky"]
        ref_offset = max(0.0, (ref_anchor - ref["bp"]) / (1 - ref["bp"]))
        for p in info[1:]:
            anchor = p["floorValue"] if use_floor else p["sky"]
            bp = max(0.0, anchor - ref_offset * (1 - p["bp"]) / p["gain"])
            p["guarded"] = False
            if p["floorValue"] > 0 and bp > p["floorValue"]:
                bp, p["guarded"] = p["floorValue"], True
            p["bp"] = bp
            p["x0"] = max(1e-6, (p["median"] - bp) / (1 - bp))

    # Highlight protection: arcsinh curve with the same median, shared by all lines
    w = max(0.0, min(100.0, s["highlightProtection"])) / 100.0
    X, b_arc = 1.0, 1.0
    if w > 0:
        for p in info:
            smp = p["sample"]
            top = float(smp[-1]) if smp.size > 0 else 1.0
            X = max(X, p["gain"] * (top - p["bp"]) / (1 - p["bp"]))
        b_arc = arcsinh_softening(ref["x0"], s["targetMedian"], X)
    for p in info:
        p["hpW"], p["hpX"], p["hpB"] = w, X, b_arc
        p["expectedMedian"] = float(stretch_array(np.array([p["gain"] * p["x0"]]), p, s, relative=True)[0])
    return info


def stretch_array(src, p, s, relative=False):
    """Applies the per-line stretch to an array. relative=True: src is already (L - BP)/(1 - BP) * gain."""
    src = src.astype(np.float64, copy=False)
    xr = src if relative else p["gain"] / (1 - p["bp"]) * (src - p["bp"])
    x = np.clip(xr, 0.0, 1.0)
    y = mtf(x, p["m"])
    w = p["hpW"]
    if w > 0:
        xa = np.clip(xr, 0.0, p["hpX"]) / p["hpB"]
        ya = np.arcsinh(xa) / math.asinh(p["hpX"] / p["hpB"])
        y = (1 - w) * y + w * ya
    g_low, g_high = contrast_gamma(s), contrast_gamma_high(s, w)
    piv = s["targetMedian"]
    if g_low > 1.000001 or g_high > 1.000001:
        yc = np.clip(y, 0.0, 1.0)
        low = piv * (yc / piv) ** g_low if g_low > 1.000001 else yc
        high = 1 - (1 - piv) * ((1 - yc) / (1 - piv)) ** g_high if g_high > 1.000001 else yc
        y = np.where(yc <= piv, low, high)
    return np.clip(y, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# Blend engine
# ---------------------------------------------------------------------------

def foraxx_rgb(H, O, S):
    x = H * O
    f = x ** (1 - x)
    G = f * H + (1 - f) * O
    if S is None:
        return H, G, O
    fo = O ** (1 - O)
    R = fo * S + (1 - fo) * H
    return R, G, O


def typical_ratio(H, O):
    """Typical OIII/(Ha+OIII) over the brighter half of the nebula (automatic balance center)."""
    h, w = H.shape
    step = max(1, int(math.floor(math.sqrt(w * h / 200000.0))))
    hs, os_ = H[::step, ::step].ravel(), O[::step, ::step].ravel()
    ok = (hs + os_) > 1e-4
    hs, os_ = hs[ok], os_[ok]
    if hs.size < 100:
        return 0.4
    lum = np.maximum(hs, os_)
    rat = os_ / (hs + os_)
    cut = np.sort(lum)[lum.size >> 1]
    sel = np.sort(rat[lum >= cut])
    return float(sel[sel.size >> 1]) if sel.size > 0 else 0.4


def gaussian(img, sigma):
    if ndimage:
        return ndimage.gaussian_filter(img, sigma, mode="nearest")
    # Fallback: three box blurs approximate a Gaussian
    r = max(1, int(round(sigma * 1.2)))
    out = img.astype(np.float64)
    for axis in (0, 1):
        for _ in range(3):
            c = np.cumsum(np.pad(out, [(r + 1, r) if a == axis else (0, 0) for a in (0, 1)], mode="edge"), axis=axis)
            if axis == 0:
                out = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
            else:
                out = (c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)
    return out.astype(np.float32)


def ratio_rgb(H, O, S, s, center, smooth_scale=1.0):
    preset = RATIO_PRESETS[s["ratioPreset"] if 0 <= s["ratioPreset"] < len(RATIO_PRESETS) else 0]
    cH, cO, cS = H, O, S
    if s["colorSmoothing"] > 0:
        rad = max(0.3, s["colorSmoothing"] / smooth_scale)
        cH, cO = gaussian(H, rad), gaussian(O, rad)
        cS = gaussian(S, rad) if S is not None else None
    eps = 1e-6
    r = cO / (cH + cO + eps)
    c = center - s["ratioBalance"] / 100.0 * 0.25
    t = np.clip(0.5 + s["ratioContrast"] * (r - c), 0.0, 1.0)
    u = None
    if S is not None:
        u = np.clip(s["siiStrength"] * cS / (cH + cS + eps), 0.0, 1.0)
    L = np.maximum(H, O) if S is None else np.maximum(np.maximum(H, O), S)
    L = s["ratioBrightness"] * L
    out = []
    for k in range(3):
        col = preset["ha"][k] * (1 - t) + preset["oiii"][k] * t
        if u is not None:
            col = col * (1 - u) + RATIO_SII_COLOUR[k] * u
        out.append(L * col)
    return out[0], out[1], out[2]


def palette_rgb(H, O, S, weights):
    src = [H, O, S]
    out = []
    for c in range(3):
        acc = np.zeros_like(H)
        for k in range(3):
            wgt = weights[c][k]
            if wgt == 0 or (k == 2 and S is None):
                continue
            acc = acc + wgt * src[k]
        out.append(acc)
    return out[0], out[1], out[2]


_ALLOWED_EXPR = re.compile(r"^[\sHOS0-9\.\+\-\*/\^\(\),<>=!a-z]*$")


def custom_rgb(H, O, S, s):
    def vmin(*a):
        r = a[0]
        for x in a[1:]:
            r = np.minimum(r, x)
        return r

    def vmax(*a):
        r = a[0]
        for x in a[1:]:
            r = np.maximum(r, x)
        return r

    funcs = {"min": vmin, "max": vmax, "sqrt": np.sqrt, "ln": np.log, "log": np.log10, "exp": np.exp,
             "abs": np.abs, "iif": np.where, "pow": np.power, "H": H, "O": O}
    if S is not None:
        funcs["S"] = S
    out = []
    for key in ("customR", "customG", "customB"):
        expr = s[key].strip()
        if not _ALLOWED_EXPR.match(expr) or "__" in expr:
            raise ValueError("Custom expression %s contains characters that are not allowed: %s" % (key[-1], expr))
        if re.search(r"\bS\b", expr) and S is None:
            raise ValueError("The custom expression uses S, but no SII image is selected.")
        val = eval(expr.replace("^", "**"), {"__builtins__": {}}, funcs)
        out.append(np.broadcast_to(np.asarray(val, dtype=np.float32), H.shape).astype(np.float32))
    return out[0], out[1], out[2]


def apply_green_reduction(R, G, B, percent):
    a = max(0.0, min(100.0, percent)) / 100.0
    if a <= 0:
        return R, G, B
    excess = np.maximum(G - (R + B) / 2, 0)
    return R, G - a * excess, B


def apply_saturation(R, G, B, k):
    if abs(k - 1) < 1e-6:
        return R, G, B
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
    return Y + k * (R - Y), Y + k * (G - Y), Y + k * (B - Y)


_CURVE_LUTS = {}
_LUT_GRID = None


def curve(points, x):
    """
    Akima-interpolated curve through points, evaluated at x in [0, 1]. The curve
    is tabulated once (4096 steps) and then looked up, which is much faster on
    millions of pixels and indistinguishable from evaluating it directly.
    """
    global _LUT_GRID
    key = tuple(map(tuple, points))
    lut = _CURVE_LUTS.get(key)
    if lut is None:
        _LUT_GRID = np.linspace(0.0, 1.0, 4096)
        pts = np.array(points, dtype=np.float64)
        lut = None
        if Akima1DInterpolator and len(pts) >= 3:
            try:
                lut = Akima1DInterpolator(pts[:, 0], pts[:, 1])(_LUT_GRID)
            except Exception:
                lut = None
        if lut is None:
            lut = np.interp(_LUT_GRID, pts[:, 0], pts[:, 1])
        _CURVE_LUTS[key] = lut
    # Evenly spaced table: compute the position directly (linear interpolation between entries)
    pos = np.clip(x, 0, 1) * (lut.size - 1)
    i = np.minimum(pos.astype(np.int32), lut.size - 2)
    f = pos - i
    return lut[i] * (1 - f) + lut[i + 1] * f


def rgb_to_hsv(R, G, B):
    mx = np.maximum(np.maximum(R, G), B)
    mn = np.minimum(np.minimum(R, G), B)
    d = mx - mn
    V = mx
    S = np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0)
    dd = np.where(d > 0, d, 1)
    h = np.where(mx == R, ((G - B) / dd) % 6, np.where(mx == G, (B - R) / dd + 2, (R - G) / dd + 4))
    Hh = np.where(d > 0, h / 6.0, 0)
    return Hh % 1.0, S, V


def hsv_to_rgb(Hh, S, V):
    h6 = (Hh % 1.0) * 6
    i = np.floor(h6).astype(int) % 6
    f = h6 - np.floor(h6)
    p = V * (1 - S)
    q = V * (1 - S * f)
    t = V * (1 - S * (1 - f))
    R = np.choose(i, [V, q, p, p, t, V])
    G = np.choose(i, [t, V, V, q, p, p])
    B = np.choose(i, [p, p, t, V, V, q])
    return R, G, B


def apply_foraxx_finishing(R, G, B):
    """ForaxxPalette's finishing (hue curve + saturation curve, second hue curve, hue-selective saturation x2)."""
    Hh, S, V = rgb_to_hsv(np.clip(R, 0, 1), np.clip(G, 0, 1), np.clip(B, 0, 1))
    Hh = curve(FORAXX_HUE_1, Hh)
    S = curve(FORAXX_SAT_1, S)
    Hh = curve(FORAXX_HUE_2, Hh)
    for _ in range(2):
        S = np.clip(S * (1 + curve(FORAXX_HUE_SAT, Hh)), 0, 1)
    return hsv_to_rgb(Hh, np.clip(S, 0, 1), V)


def blend_warning(s, have_sii):
    if have_sii:
        return ""
    if s["blendMode"] == BLEND_PALETTE:
        w = s["paletteWeights"]
        if any(w[c][2] for c in range(3)):
            empty = [["red", "green", "blue"][c] for c in range(3) if w[c][2] and not w[c][0] and not w[c][1]]
            return ("No SII image selected: this palette's SII terms are zero" +
                    (" (%s channel empty)" % " and ".join(empty) if empty else "") + ". Select SII, or use HOO.")
    if s["blendMode"] == BLEND_CUSTOM:
        if re.search(r"\bS\b", s["customR"] + " " + s["customG"] + " " + s["customB"]):
            return "No SII image selected, but the custom expressions use S."
    return ""


def blend(stretched, s, smooth_scale=1.0, log=None, center=None):
    """
    stretched: {line: array}. Returns an (3, h, w) float32 RGB array.
    center: ratio color center to use instead of measuring it (a zoomed preview
    crop uses the center of the whole image, so colors match the full view).
    """
    s = sanitized(s)
    H, O, S = stretched[L_HA], stretched[L_OIII], stretched.get(L_SII)
    mode = s["blendMode"]
    if mode == BLEND_RATIO:
        if center is None:
            center = typical_ratio(H, O)
        if log:
            log("  ratio color: center %.3f (auto), balance %d, contrast %.1f" % (center, round(s["ratioBalance"]), s["ratioContrast"]))
        R, G, B = ratio_rgb(H, O, S, s, center, smooth_scale)
    elif mode == BLEND_PALETTE:
        R, G, B = palette_rgb(H, O, S, s["paletteWeights"])
    elif mode == BLEND_CUSTOM:
        R, G, B = custom_rgb(H, O, S, s)
    else:
        R, G, B = foraxx_rgb(H, O, S)
    R, G, B = apply_green_reduction(R, G, B, s["greenReduction"])
    R, G, B = apply_saturation(R, G, B, s["saturation"])
    R, G, B = [np.clip(c, 0, 1) for c in (R, G, B)]
    if s["foraxxFinishing"]:
        R, G, B = apply_foraxx_finishing(R, G, B)
    return np.clip(np.nan_to_num(np.stack([R, G, B]), nan=0.0, posinf=1.0, neginf=0.0), 0, 1).astype(np.float32)


# ---------------------------------------------------------------------------
# Pipeline (shared by the preview and Apply)
# ---------------------------------------------------------------------------

# Allowed range of each numeric setting (values outside are clamped)
SETTING_RANGES = {
    "shadowClip": (0.0, 8.0), "targetMedian": (0.05, 0.5), "link": (0.0, 100.0), "contrast": (0.0, 100.0),
    "highlightProtection": (0.0, 100.0), "ratioBalance": (-100.0, 100.0), "ratioContrast": (0.5, 10.0),
    "siiStrength": (0.0, 3.0), "ratioBrightness": (0.5, 2.5), "colorSmoothing": (0.0, 10.0),
    "saturation": (0.0, 3.0), "greenReduction": (0.0, 100.0),
}


def sanitized(s):
    """A copy of the settings with every number inside its allowed range."""
    out = dict(s)
    for k, (lo, hi) in SETTING_RANGES.items():
        try:
            v = float(out[k])
        except (TypeError, ValueError, KeyError):
            v = default_settings()[k]
        if v != v:   # NaN
            v = default_settings()[k]
        out[k] = min(hi, max(lo, v))
    return out


def process(images, s, sources=None, smooth_scale=1.0, log=None):
    """
    images:  {line: full-resolution linear array}, Ha and OIII required.
    sources: {line: array} to apply the stretch to (downsampled copies for the
             preview); measurements always come from the full images.
    Returns (stretched {line: array}, info).
    """
    s = sanitized(s)
    lines = [(L_HA, "Ha", images[L_HA]), (L_OIII, "OIII", images[L_OIII])]
    if images.get(L_SII) is not None:
        lines.append((L_SII, "SII", images[L_SII]))
    shape = images[L_HA].shape
    for line, _, img in lines:
        if img.shape != shape:
            raise ValueError("%s has different dimensions from Ha (%dx%d vs %dx%d). Are the images registered?" %
                             (LINE_NAMES[line], img.shape[1], img.shape[0], shape[1], shape[0]))
    info = stretch_parameters(analyze_lines(lines, s), s)
    if log:
        log("  shadow clip %.1f sigma, target median %.3f, link %d%%, midtones %.6f" %
            (s["shadowClip"], s["targetMedian"], round(s["link"]), info[0]["m"]))
    stretched = {}
    for p in info:
        src = sources[p["line"]] if sources is not None else images[p["line"]]
        stretched[p["line"]] = stretch_array(src, p, s)
        if log:
            log("  %-4s sky %.3e  noise %.3e  black point %.3e%s  median %.3e  gain %.3f  -> median %.3f  (%.2f%% at black)" %
                (LINE_NAMES[p["line"]], p["sky"], p["sigma"], p["bp"], " (guarded)" if p["guarded"] else "", p["median"],
                 p["gain"], p["expectedMedian"], 100 * fraction_below(p["sample"], p["bp"])))
    return stretched, info


def resample_to(img, out_w, out_h):
    """Area-average reduction to (out_w, out_h): whole-pixel binning, then a gentle linear resize."""
    h, w = img.shape
    f = max(1, int(math.floor(min(w / float(out_w), h / float(out_h)))))
    small = downsample(img, f)
    sh, sw = small.shape
    if (sw, sh) == (out_w, out_h) or not ndimage:
        return small
    return ndimage.zoom(small, (out_h / float(sh), out_w / float(sw)), order=1, prefilter=False).astype(np.float32)


def downsample(img, f):
    if f <= 1:
        return img
    h, w = img.shape
    h2, w2 = h // f, w // f
    return img[:h2 * f, :w2 * f].reshape(h2, f, w2, f).mean(axis=(1, 3)).astype(np.float32)


# ---------------------------------------------------------------------------
# FITS input / output (minimal, no extra packages needed)
# ---------------------------------------------------------------------------

_WCS_KEYS = re.compile(r"^(CTYPE\d|CRVAL\d|CRPIX\d|CDELT\d|CROTA\d|CUNIT\d|CD\d_\d|PC\d_\d|PV\d_\d+|A_\w+|B_\w+|AP_\w+|BP_\w+|"
                       r"EQUINOX|RADESYS|RADECSYS|LONPOLE|LATPOLE|OBJECT|DATE-OBS|TELESCOP|INSTRUME|FOCALLEN|XPIXSZ|YPIXSZ|"
                       r"RA|DEC|OBJCTRA|OBJCTDEC|SITELAT|SITELONG)$")


def read_fits(path):
    """Returns (array (h, w) or (c, h, w) as float32 in [0, 1], list of header cards)."""
    with open(path, "rb") as f:
        raw = f.read()
    cards, pos = [], 0
    while True:
        block = raw[pos:pos + 2880]
        if len(block) < 2880:
            raise ValueError("Not a valid FITS file: " + os.path.basename(path))
        pos += 2880
        done = False
        for i in range(36):
            card = block[i * 80:(i + 1) * 80].decode("ascii", "replace")
            cards.append(card)
            if card.startswith("END") and card[3:].strip() == "":
                done = True
                break
        if done:
            break
    hdr = {}
    for c in cards:
        if len(c) > 10 and c[8:10] == "= ":
            key = c[:8].strip()
            val = c[10:].split("/")[0].strip() if not c[10:].strip().startswith("'") else c[10:].strip()
            hdr[key] = val
    bitpix = int(hdr["BITPIX"])
    naxis = int(hdr["NAXIS"])
    if naxis not in (2, 3):
        raise ValueError("Unsupported FITS layout (NAXIS=%d): %s" % (naxis, os.path.basename(path)))
    w, h = int(hdr["NAXIS1"]), int(hdr["NAXIS2"])
    c = int(hdr["NAXIS3"]) if naxis == 3 else 1
    dtype = {8: ">u1", 16: ">i2", 32: ">i4", -32: ">f4", -64: ">f8"}[bitpix]
    n = w * h * c
    data = np.frombuffer(raw, dtype=dtype, count=n, offset=pos).astype(np.float64)
    bzero = float(hdr.get("BZERO", "0") or 0)
    bscale = float(hdr.get("BSCALE", "1") or 1)
    data = data * bscale + bzero
    if bitpix > 0:
        data = data / {8: 255.0, 16: 65535.0, 32: 4294967295.0}[bitpix]
    elif np.nanmax(data) > 1.5:
        data = data / 65535.0
    data = np.nan_to_num(data, nan=0.0, posinf=1.0, neginf=0.0)
    arr = data.reshape((c, h, w) if c > 1 else (h, w)).astype(np.float32)
    keep = [cd for cd in cards if _WCS_KEYS.match(cd[:8].strip())]
    return arr, keep


def write_fits(path, data, extra_cards=None):
    """Writes a 32-bit float FITS image: data (h, w) or (3, h, w), values in [0, 1]."""
    data = np.asarray(data, dtype=np.float32)

    def card(key, value, comment=""):
        if isinstance(value, bool):
            v = ("T" if value else "F").rjust(20)
        elif isinstance(value, (int, float)):
            v = str(value).rjust(20)
        else:
            v = ("'" + str(value).replace("'", "''").ljust(8) + "'").ljust(20)
        s = ("%-8s= %s" % (key, v)) + (" / " + comment if comment else "")
        return s[:80].ljust(80)

    cards = [card("SIMPLE", True), card("BITPIX", -32), card("NAXIS", data.ndim)]
    if data.ndim == 2:
        cards += [card("NAXIS1", data.shape[1]), card("NAXIS2", data.shape[0])]
    else:
        cards += [card("NAXIS1", data.shape[2]), card("NAXIS2", data.shape[1]), card("NAXIS3", data.shape[0])]
    cards += [card("BZERO", 0.0), card("BSCALE", 1.0), card("PROGRAM", "NarrowbandProcessing " + VERSION)]
    if data.ndim == 3:
        cards.append(card("CTYPE3", "RGB"))
    for c in extra_cards or []:
        if not c.startswith("CTYPE3"):
            cards.append(c[:80].ljust(80))
    cards.append("END".ljust(80))
    header = "".join(cards)
    header += " " * ((2880 - len(header) % 2880) % 2880)
    body = data.astype(">f4").tobytes()
    body += b"\0" * ((2880 - len(body) % 2880) % 2880)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(body)


def unique_path(folder, base, ext=".fit"):
    p = os.path.join(folder, base + ext)
    n = 1
    while os.path.exists(p):
        p = os.path.join(folder, "%s_%d%s" % (base, n, ext))
        n += 1
    return p


# ---------------------------------------------------------------------------
# Help guide
# ---------------------------------------------------------------------------

GUIDE = """# NarrowbandProcessing {version} guide

NarrowbandProcessing turns **linear** narrowband line images (Ha, OIII and optionally SII) into a finished-looking color image. It **stretches** each line (makes the faint nebula visible) and **blends** them into color. The preview shows the result at reduced size; **Apply** creates the full-size image and opens it in Siril.

## Quick start

1. **Get your line images** as linear FITS files, registered to each other (same size and alignment).
   - Mono camera with separate filters: use your stacked Ha, OIII and SII masters.
   - Color camera with a dual-band filter (L-eNhance, L-eXtreme, ...): extract the lines first, for example with Siril's Ha/OIII extraction, and save them as FITS.
2. **Choose the files** at the top: Ha and OIII are required, SII is optional.
3. **Choose a Mode** in the Blend section. Foraxx is a great starting point; sensible defaults are set for each mode.
4. **Adjust while watching the preview.** Usually only Contrast, Highlight protection and Saturation need changing.
5. **Click Apply.** The result is saved in Siril's working folder (NB_Foraxx.fit, NB_Ratio.fit, ...) and opened in Siril.

## Stretch controls

**Shadow clip** - how dark the background gets. The black point is set from the real sky background, a number of noise levels (sigma) below it. Lower = darker, deeper shadows; higher = softer, more faint detail kept. Default 3.

**Target median** - overall brightness. 0.25 suits most images; lower is darker and moodier.

**Link lines** - how the fainter lines (OIII, SII) are stretched compared with Ha.
- 0%: every line is brightened to the same level. Needed for Foraxx and classic palettes, which expect balanced lines.
- 100%: all lines share one stretch, so faint OIII stays faint. Cleaner shadows, less noise.
- In between: faint lines catch up partway. Ratio color defaults to 75%.

**Contrast** - darker shadows and dust lanes, more punch in the mid-tones. The background and overall brightness stay put. 30-50 suits most targets.

**Highlight protection** - keeps detail in very bright regions, such as the core of M42, instead of letting them turn white. Leave at 0 for most targets; use 50-80 for bright cores.

**Neutral background** - keeps the empty sky gray rather than tinted. Leave it on.

## Blend modes

**Foraxx (dynamic)** - the popular Foraxx palette: gold where Ha dominates, blue where OIII dominates. HOO with Ha and OIII; SHO automatically when SII is selected. Use with Link 0% and Foraxx finishing on.

**Ratio color** - color comes from how much OIII there is compared with Ha.
- Colors: the color pair, e.g. Gold + blue core.
- Balance: moves the gold/blue split. Negative = more gold, positive = more blue. 0 centers it on your image automatically.
- Contrast (blend): how sharply gold changes into blue.
- SII strength: how strongly SII adds red-orange (only with an SII image).
- Brightness: overall brightness of this mode.
- Color smoothing: removes color speckle in faint areas without blurring detail. 2 px is a good default.

**Classic palette** - fixed mixes like HOO, SHO (Hubble palette) and HSO. The grid shows how much of each line goes into red, green and blue; you can edit it. Raw SHO is naturally very green, so use Green reduction.

**Custom expressions** - your own red, green and blue formulas using H, O and S (the stretched lines). Example: R = H, G = 0.5*H + 0.5*O, B = O. Available functions: min, max, sqrt, ln, exp, abs, pow, iif; ^ means power.

## Finishing controls

**Saturation** - color strength (1 = unchanged). Brightness is not affected.

**Green reduction** - removes excess green, like SCNR. Use 70-100% for SHO.

**Foraxx finishing** - hue and saturation curves from the ForaxxPalette utility: reds pushed towards gold, blues deepened, gold and blue boosted. Works with any mode.

**Reset all sliders** - puts every Stretch and Blend slider back to its default for the current mode. Your files and mode are kept.

**Keep stretched mono lines** - also saves the stretched lines (_HA_s.fit, _OIII_s.fit, _SII_s.fit) in the working folder.

## Preview

The preview updates shortly after each change and is computed at your screen's full resolution, so it stays sharp on large and Retina / HiDPI screens.
- **Zoom: Fit** shows the whole image. **100% (1:1)** shows real pixels, which is best for judging noise, color speckle and fine detail. **Double-click** the preview to zoom to 100% at that spot, and again to go back to Fit. In 100% view, **drag** to pan.
- **Quality: Sharp** uses full screen resolution and is recommended. **Balanced** (70%) and **Fast** (50%) are for slower computers: they update quicker but look softer, because the preview is enlarged to fill the panel. The status line shows how long each update takes.
- **Show** switches between the blend and each stretched line on its own.
- Untick **Live update** to change several settings first, then click **Refresh**.

The first update after choosing files takes a few seconds while the full images are measured.

## Recipes

**Classic Foraxx look** - Mode Foraxx, Link 0%, Contrast 40, Foraxx finishing on.

**Gold + blue** - Mode Ratio color, Colors Gold + blue core, Link 75%, Contrast 30-40, Color smoothing 2, Saturation 1.2-1.4.

**Hubble palette (SHO)** - needs an SII image. Mode Classic palette, Palette SHO, Link 0%, Green reduction 80-100%, Saturation about 1.3. Or simply use Foraxx with SII selected.

**Very bright core (M42)** - any mode, Highlight protection 50-80.

## Troubleshooting

**Everything is green or cyan** - a palette that uses SII is selected but no SII image is (the preview shows a warning). Choose SII or use HOO. With real SII, raw SHO is green by nature: use Green reduction.

**Foraxx shows little or no blue** - set Link lines to 0%.

**Shadows or dust lanes look blue** - raise Link lines, so OIII's background noise is not brightened as much.

**Background has a color cast** - make sure Neutral background is ticked.

**Faint areas full of colored speckle** (Ratio color) - raise Color smoothing.

**Image looks flat or gray** - raise Contrast, and for Foraxx make sure Foraxx finishing is on.

**Bright core is pure white** - raise Highlight protection. If it stays white, the core may be saturated in the data itself; only shorter exposures can recover it.

**"Different dimensions"** - the images are not registered to each other. Register them (for example with Siril's registration) before using this script.

**Colors change a lot after gradient removal** - on nebulae that fill the whole frame, automatic gradient tools can remove real nebulosity (often the blue OIII haze). Skip gradient removal, or place background samples only in the darkest areas.

NarrowbandProcessing {version} by Justin Pickens, GPL v3. Foraxx finishing curve settings from Paul Hancock's ForaxxPalette utility.
"""


# ---------------------------------------------------------------------------
# Window logic (no Qt) and Siril connection
# ---------------------------------------------------------------------------

AUTHOR = "Justin Pickens"
CONTACT_URL = "https://github.com/justinthedark/NarrowbandProcessing/issues"
HOME_URL = "https://github.com/justinthedark/NarrowbandProcessing"


class Controller:
    """
    Everything the window does, without any Qt: loading images, the preview
    and Apply. Keeps the interface code thin and testable.
    """

    def __init__(self, siril=None):
        self.siril = siril
        self.s = default_settings()
        self.paths = {}
        self.images = {}
        self.cards = {}
        self.preview_src = None
        self.factor = 1

    def log(self, msg):
        try:
            if self.siril is not None:
                self.siril.log(msg)
                return
        except Exception:
            pass
        print(msg)

    def progress(self, msg, frac):
        try:
            if self.siril is not None:
                self.siril.update_progress(msg, frac)
        except Exception:
            pass

    def ready(self):
        return L_HA in self.images and L_OIII in self.images

    def load_line(self, line, path):
        arr, cards = read_fits(path)
        if arr.ndim != 2:
            raise ValueError("%s is a color image. Choose a mono (single-channel) line image." % os.path.basename(path))
        self.paths[line], self.images[line], self.cards[line] = path, arr, cards
        self.preview_src = None
        clear_measure_cache()

    def clear_line(self, line):
        self.paths.pop(line, None)
        self.images.pop(line, None)
        self.cards.pop(line, None)
        self.preview_src = None

    def _fit_sources(self, out_w, out_h):
        """Copies of the inputs reduced to the preview size (cached per size)."""
        key = (out_w, out_h)
        if self.preview_src is None or getattr(self, "_src_key", None) != key:
            self._src_key = key
            self.preview_src = {l: resample_to(a, out_w, out_h) for l, a in self.images.items()}
        return self.preview_src

    def ratio_center(self):
        """Ratio color center of the whole image (from a small overview)."""
        h, w = self.images[L_HA].shape
        f = max(1, int(math.ceil(max(h, w) / 800.0)))
        key = (f, tuple(sorted((k, v) for k, v in sanitized(self.s).items()
                               if k in ("shadowClip", "targetMedian", "link", "contrast", "highlightProtection", "neutralBackground"))))
        if getattr(self, "_center_key", None) != key:
            small = {l: downsample(a, f) for l, a in self.images.items()}
            st, _ = process(self.images, self.s, sources=small)
            self._center = typical_ratio(st[L_HA], st[L_OIII])
            self._center_key = key
        return self._center

    def preview(self, show, target_w=PREVIEW_SIZE, target_h=None, zoom=0, center_xy=None):
        """
        show:      0 = blend, 1-3 = a stretched line.
        target_w/h: size of the preview area in device pixels (screen resolution).
        zoom:      0 = fit the whole image; 1 = 100% (1:1 pixels) crop around center_xy.
        center_xy: (x, row) in image coordinates for the 1:1 view (default: image center).
        Returns (uint8 h x w x 3 array, warning, info) where info describes the view.
        """
        if not self.ready():
            raise ValueError("Choose the Ha and OIII images.")
        h, w = self.images[L_HA].shape
        target_w = max(64, int(target_w))
        target_h = max(64, int(target_h if target_h else target_w * 0.72))
        center = None
        if zoom == 1:
            cx, cy = center_xy if center_xy else (w / 2.0, h / 2.0)
            cw, ch = min(w, target_w), min(h, target_h)
            x0 = int(round(min(max(cx - cw / 2.0, 0), w - cw)))
            y0 = int(round(min(max(cy - ch / 2.0, 0), h - ch)))
            sources = {l: a[y0:y0 + ch, x0:x0 + cw] for l, a in self.images.items()}
            scale = 1
            info = {"zoom": 1, "x0": x0, "y0": y0, "w": cw, "h": ch, "center": (x0 + cw / 2.0, y0 + ch / 2.0)}
            if show == 0 and self.s["blendMode"] == BLEND_RATIO:
                center = self.ratio_center()
        else:
            # Computed at exactly the screen resolution of the preview area (never upscaled)
            scale = max(1.0, max(w / float(target_w), h / float(target_h)))
            out_w, out_h = max(1, int(round(w / scale))), max(1, int(round(h / scale)))
            sources = self._fit_sources(out_w, out_h)
            self.factor = scale
            info = {"zoom": 0, "factor": scale}
        stretched, _ = process(self.images, self.s, sources=sources)
        warning = ""
        if show == 0:
            rgb = np.transpose(blend(stretched, self.s, smooth_scale=scale, center=center), (1, 2, 0))
            warning = blend_warning(self.s, L_SII in self.images)
        else:
            line = show - 1
            if line not in stretched:
                raise ValueError("No %s image selected." % LINE_NAMES[line])
            m = stretched[line]
            rgb = np.stack([m, m, m], axis=2)
        # FITS rows run bottom-up; flip so the preview matches Siril's display
        rgb8 = np.ascontiguousarray((np.clip(np.flipud(rgb), 0, 1) * 255 + 0.5).astype(np.uint8))
        return rgb8, warning, info

    def apply(self):
        """Full-size stretch and blend; saves the result and opens it in Siril. Returns the output path."""
        if not self.ready():
            raise ValueError("Choose at least the Ha and OIII images.")
        s = self.s
        self.log("%s %s" % (TITLE, VERSION))
        self.log("  inputs: Ha %s, OIII %s, %s" % (os.path.basename(self.paths[L_HA]), os.path.basename(self.paths[L_OIII]),
                                                   "SII " + os.path.basename(self.paths[L_SII]) if L_SII in self.images else "no SII"))
        self.log("  stretch: shadow clip %.1f, target median %.3f, link %d%%, contrast %d, highlight protection %d, neutral background %s" %
                 (s["shadowClip"], s["targetMedian"], round(s["link"]), round(s["contrast"]), round(s["highlightProtection"]),
                  "on" if s["neutralBackground"] else "off"))
        self.log("  blend: %s, saturation %.2f, green reduction %d%%, Foraxx finishing %s" %
                 (BLEND_NAMES[s["blendMode"]], s["saturation"], round(s["greenReduction"]), "on" if s["foraxxFinishing"] else "off"))
        self.progress("NarrowbandProcessing: stretching", 0.2)
        stretched, _ = process(self.images, s, log=self.log)
        warn = blend_warning(s, L_SII in self.images)
        if warn:
            self.log("  Warning: " + warn)
        self.progress("NarrowbandProcessing: blending", 0.6)
        rgb = blend(stretched, s, log=self.log)
        folder = ""
        try:
            if self.siril is not None:
                folder = self.siril.get_siril_wd()
        except Exception:
            folder = ""
        if not folder or not os.path.isdir(folder):
            folder = os.path.dirname(self.paths[L_HA])
        cards = self.cards.get(L_HA, [])
        if s["keepMono"]:
            for line, arr in stretched.items():
                mp = unique_path(folder, LINE_OUTPUT_NAMES[line])
                write_fits(mp, arr, cards)
                self.log("  saved " + os.path.basename(mp))
        out = unique_path(folder, "NB_" + BLEND_TAGS[s["blendMode"]])
        write_fits(out, rgb, cards)
        self.log("  saved " + out)
        self.progress("NarrowbandProcessing: done", 1.0)
        if self.siril is not None:
            self.siril.cmd("load", '"%s"' % out)
        self.log("%s finished: %s" % (TITLE, os.path.basename(out)))
        return out


def guide_html():
    """The guide text as simple HTML for the Help window (numbered steps may contain indented bullets)."""
    import html as _html
    out = []
    stack = []          # open lists, e.g. ["ol"] or ["ol", "ul"]
    li_open = []        # whether an <li> is open at each level

    def close_to(depth):
        while len(stack) > depth:
            if li_open[-1]:
                out.append("</li>")
            out.append("</%s>" % stack.pop())
            li_open.pop()

    def item(kind, depth, text):
        close_to(depth + 1)
        if len(stack) == depth + 1 and stack[-1] != kind:
            close_to(depth)
        if len(stack) < depth + 1:
            out.append("<%s>" % kind)
            stack.append(kind)
            li_open.append(False)
        if li_open[-1]:
            out.append("</li>")
        out.append("<li>%s" % text)
        li_open[-1] = True

    for line in GUIDE.format(version=VERSION).split("\n"):
        esc = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", _html.escape(line))
        m_ol = re.match(r"^(\d+)\. (.*)$", esc)
        m_sub = re.match(r"^\s+- (.*)$", esc)
        m_ul = re.match(r"^- (.*)$", esc)
        if m_ol:
            item("ol", 0, m_ol.group(2))
        elif m_sub and stack:
            item("ul", 1, m_sub.group(1))
        elif m_ul:
            item("ul", 0, m_ul.group(1))
        elif not line.strip():
            continue
        else:
            close_to(0)
            if esc.startswith("# "):
                out.append("<h2>%s</h2>" % esc[2:])
            elif esc.startswith("## "):
                out.append("<h3>%s</h3>" % esc[3:])
            else:
                out.append("<p>%s</p>" % esc)
    close_to(0)
    out.append('<p>Questions and bug reports: <a href="%s">%s</a></p>' % (CONTACT_URL, CONTACT_URL))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# User interface (PyQt6)
# ---------------------------------------------------------------------------

def dark_palette(QtGui, QtCore):
    """A dark Fusion palette close to Siril's own interface (same on every platform)."""
    P, C = QtGui.QPalette, QtGui.QColor
    pal = P()
    roles = {
        P.ColorRole.Window: "#2b2b2b", P.ColorRole.WindowText: "#e6e6e6", P.ColorRole.Base: "#1e1e1e",
        P.ColorRole.AlternateBase: "#323232", P.ColorRole.ToolTipBase: "#1e1e1e", P.ColorRole.ToolTipText: "#e6e6e6",
        P.ColorRole.Text: "#e6e6e6", P.ColorRole.Button: "#3d3d3d", P.ColorRole.ButtonText: "#e6e6e6",
        P.ColorRole.BrightText: "#ffffff", P.ColorRole.Link: "#6aa9ec", P.ColorRole.Highlight: "#4a90d9",
        P.ColorRole.HighlightedText: "#ffffff", P.ColorRole.PlaceholderText: "#8a8a8a",
    }
    for role, color in roles.items():
        pal.setColor(role, C(color))
    for role in (P.ColorRole.WindowText, P.ColorRole.Text, P.ColorRole.ButtonText):
        pal.setColor(P.ColorGroup.Disabled, role, C("#777777"))
    return pal


def run_gui(siril):
    from PyQt6 import QtCore, QtGui, QtWidgets
    Qt = QtCore.Qt

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setPalette(dark_palette(QtGui, QtCore))
    app.setStyleSheet("QGroupBox { font-weight: bold; color: #6aa9ec; border: 1px solid #555; border-radius: 4px;"
                      " margin-top: 10px; padding-top: 6px; }"
                      " QGroupBox::title { subcontrol-origin: margin; left: 8px; padding: 0 3px; }")

    ctl = Controller(siril)
    s = ctl.s
    show_names = ["Blend", "Ha (stretched)", "OIII (stretched)", "SII (stretched)"]

    class PreviewLabel(QtWidgets.QLabel):
        """
        Shows the preview at the screen's real resolution (device pixels, so it
        stays sharp on Retina / HiDPI displays). Double-click zooms to 100% at
        that point or back to fit; in 100% view, drag to pan.
        """
        def __init__(self):
            super().__init__()
            self.setMinimumSize(480, 340)
            self.setSizePolicy(QtWidgets.QSizePolicy.Policy.Expanding, QtWidgets.QSizePolicy.Policy.Expanding)
            self.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.setStyleSheet("background: #1e1e1e; color: #e0e0e0;")
            self.setWordWrap(True)
            self._pix = None
            self._shown = None          # (x, y, w, h) of the displayed image in widget coordinates
            self._drag = None
            self.on_resized = None      # callbacks set by the window
            self.on_double_click = None
            self.on_drag = None
            self.on_drag_end = None

        def dpr(self):
            try:
                return float(self.devicePixelRatioF())
            except Exception:
                return 1.0

        def device_size(self):
            r = self.dpr()
            return int(self.width() * r), int(self.height() * r)

        def set_image(self, pix, fit):
            self._pix, self._fit = pix, fit
            self._rescale()

        def set_message(self, text):
            self._pix = None
            self._shown = None
            self.clear()
            self.setText(text)

        def _rescale(self):
            if self._pix is None:
                return
            r = self.dpr()
            dw, dh = self.device_size()
            pix = self._pix
            if self._fit or pix.width() > dw or pix.height() > dh:
                pix = pix.scaled(dw, dh, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            pix.setDevicePixelRatio(r)
            self.setPixmap(pix)
            lw, lh = pix.width() / r, pix.height() / r
            self._shown = ((self.width() - lw) / 2.0, (self.height() - lh) / 2.0, lw, lh)

        def to_image_fraction(self, pos):
            """Mouse position as a fraction (0-1) across the displayed image, or None outside it."""
            if self._shown is None:
                return None
            x, y, w, h = self._shown
            fx, fy = (pos.x() - x) / w, (pos.y() - y) / h
            if 0 <= fx <= 1 and 0 <= fy <= 1:
                return fx, fy
            return None

        def resizeEvent(self, e):
            super().resizeEvent(e)
            self._rescale()
            if self.on_resized:
                self.on_resized()

        def mouseDoubleClickEvent(self, e):
            if self.on_double_click:
                self.on_double_click(self.to_image_fraction(e.position()))

        def mousePressEvent(self, e):
            self._drag = (e.position().x(), e.position().y())

        def mouseMoveEvent(self, e):
            if self._drag is not None and self.on_drag:
                x, y = e.position().x(), e.position().y()
                r = self.dpr()
                self.on_drag((x - self._drag[0]) * r, (y - self._drag[1]) * r)
                self._drag = (x, y)

        def mouseReleaseEvent(self, e):
            if self._drag is not None and self.on_drag_end:
                self.on_drag_end()
            self._drag = None

    win = QtWidgets.QWidget()
    win.setWindowTitle("%s %s" % (TITLE, VERSION))
    outer = QtWidgets.QVBoxLayout(win)

    header = QtWidgets.QLabel('<b>%s %s</b> &nbsp;&middot;&nbsp; by %s &nbsp;&middot;&nbsp; GPL v3 &nbsp;&middot;&nbsp; '
                              'Questions and bug reports: <a href="%s">GitHub issues</a>' % (TITLE, VERSION, AUTHOR, CONTACT_URL))
    header.setOpenExternalLinks(True)
    header.setStyleSheet("padding: 4px; background: #232f3e; color: #e6e6e6;")
    outer.addWidget(header)

    columns = QtWidgets.QHBoxLayout()
    outer.addLayout(columns, 1)
    left = QtWidgets.QVBoxLayout()
    columns.addLayout(left)

    timer = QtCore.QTimer()
    timer.setSingleShot(True)
    timer.setInterval(350)
    live = {"on": True}

    def schedule(force=False):
        if force or live["on"]:
            timer.start()

    setters = {}

    def slider(form, key, label, lo, hi, decimals, tip=""):
        steps = 1000
        spin = QtWidgets.QDoubleSpinBox()
        spin.setRange(lo, hi)
        spin.setDecimals(decimals)
        spin.setSingleStep(10 ** -decimals if decimals > 0 else 1)
        spin.setValue(s[key])
        spin.setMinimumWidth(70)
        sl = QtWidgets.QSlider(Qt.Orientation.Horizontal)
        sl.setRange(0, steps)

        def to_pos(v):
            return int(round((v - lo) / float(hi - lo) * steps))

        sl.setValue(to_pos(s[key]))

        def on_slider(pos):
            v = lo + (hi - lo) * pos / float(steps)
            v = round(v, decimals)
            spin.blockSignals(True); spin.setValue(v); spin.blockSignals(False)
            s[key] = float(v)
            schedule()

        def on_spin(v):
            sl.blockSignals(True); sl.setValue(to_pos(v)); sl.blockSignals(False)
            s[key] = float(v)
            schedule()

        sl.valueChanged.connect(on_slider)
        spin.valueChanged.connect(on_spin)
        row = QtWidgets.QHBoxLayout()
        row.addWidget(spin)
        row.addWidget(sl, 1)
        lab = QtWidgets.QLabel(label)
        if tip:
            lab.setToolTip(tip); spin.setToolTip(tip); sl.setToolTip(tip)
        form.addRow(lab, row)

        def setter(v):
            spin.blockSignals(True); sl.blockSignals(True)
            spin.setValue(v); sl.setValue(to_pos(v))
            spin.blockSignals(False); sl.blockSignals(False)
        setters[key] = setter

    def checkbox(form, key, label, tip=""):
        cb = QtWidgets.QCheckBox(label)
        cb.setChecked(bool(s[key]))
        if tip:
            cb.setToolTip(tip)

        def on(state):
            s[key] = cb.isChecked()
            schedule()
        cb.stateChanged.connect(on)
        form.addRow("", cb)
        setters[key] = lambda v: (cb.blockSignals(True), cb.setChecked(bool(v)), cb.blockSignals(False))

    # ---- inputs
    gb_in = QtWidgets.QGroupBox("Linear line images (FITS)")
    grid = QtWidgets.QGridLayout(gb_in)
    path_labels = {}

    def choose(line):
        start = os.path.dirname(ctl.paths.get(L_HA, "")) or os.getcwd()
        path, _ = QtWidgets.QFileDialog.getOpenFileName(win, "Choose the %s image" % LINE_NAMES[line], start,
                                                        "FITS images (*.fit *.fits *.fts *.FIT *.FITS);;All files (*)")
        if not path:
            return
        QtWidgets.QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            ctl.load_line(line, path)
            path_labels[line].setText(os.path.basename(path))
            path_labels[line].setToolTip(path)
        except Exception as e:
            QtWidgets.QMessageBox.critical(win, TITLE, "Could not read the image:\n%s" % e)
        finally:
            QtWidgets.QApplication.restoreOverrideCursor()
        schedule(True)

    def clear(line):
        ctl.clear_line(line)
        path_labels[line].setText("(none)")
        schedule(True)

    for r, (line, label, optional) in enumerate([(L_HA, "Ha:", False), (L_OIII, "OIII:", False), (L_SII, "SII:", True)]):
        grid.addWidget(QtWidgets.QLabel(label), r, 0)
        pl = QtWidgets.QLabel("(none)")
        pl.setMinimumWidth(220)
        path_labels[line] = pl
        grid.addWidget(pl, r, 1)
        b = QtWidgets.QPushButton("Choose...")
        b.clicked.connect(lambda _c=False, l=line: choose(l))
        grid.addWidget(b, r, 2)
        if optional:
            c = QtWidgets.QPushButton("Clear")
            c.clicked.connect(lambda _c=False, l=line: clear(l))
            grid.addWidget(c, r, 3)
    left.addWidget(gb_in)

    # ---- stretch
    gb_st = QtWidgets.QGroupBox("Stretch")
    f_st = QtWidgets.QFormLayout(gb_st)
    slider(f_st, "shadowClip", "Shadow clip:", 0.0, 8.0, 1,
           "Black point, in noise levels (sigma) below the measured sky. Lower = darker shadows.")
    slider(f_st, "targetMedian", "Target median:", 0.05, 0.50, 3, "Overall brightness. 0.25 suits most images.")
    slider(f_st, "link", "Link lines (%):", 0, 100, 0,
           "0% = every line brightened to the same level (Foraxx, palettes). 100% = true relative brightness (cleaner shadows).")
    hint = QtWidgets.QLabel("0% = equal medians      100% = true relative brightness")
    hint.setStyleSheet("color: #a8a8a8;")
    f_st.addRow("", hint)
    slider(f_st, "contrast", "Contrast:", 0, 100, 0, "Darker shadows and dust lanes, more punch in the mid-tones.")
    slider(f_st, "highlightProtection", "Highlight protection:", 0, 100, 0,
           "Keeps detail in very bright regions (e.g. M42's core). 0 for most targets, 50-80 for bright cores.")
    checkbox(f_st, "neutralBackground", "Neutral background", "Keeps the empty sky gray rather than tinted.")
    left.addWidget(gb_st)

    # ---- blend
    gb_bl = QtWidgets.QGroupBox("Blend")
    v_bl = QtWidgets.QVBoxLayout(gb_bl)
    f_mode = QtWidgets.QFormLayout()
    mode_combo = QtWidgets.QComboBox()
    mode_combo.addItems(BLEND_NAMES)
    mode_combo.setCurrentIndex(s["blendMode"])
    f_mode.addRow("Mode:", mode_combo)
    v_bl.addLayout(f_mode)

    w_ratio = QtWidgets.QWidget()
    f_ratio = QtWidgets.QFormLayout(w_ratio)
    f_ratio.setContentsMargins(0, 0, 0, 0)
    preset_combo = QtWidgets.QComboBox()
    preset_combo.addItems([p["name"] for p in RATIO_PRESETS])
    preset_combo.setCurrentIndex(s["ratioPreset"])

    def on_preset(i):
        s["ratioPreset"] = i
        schedule()
    preset_combo.currentIndexChanged.connect(on_preset)
    f_ratio.addRow("Colors:", preset_combo)
    slider(f_ratio, "ratioBalance", "Balance:", -100, 100, 0, "Negative = more gold, positive = more blue. 0 = automatic.")
    slider(f_ratio, "ratioContrast", "Contrast:", 0.5, 10.0, 1, "How sharply gold changes into blue.")
    slider(f_ratio, "siiStrength", "SII strength:", 0.0, 3.0, 2, "How strongly SII adds red-orange (with an SII image).")
    slider(f_ratio, "ratioBrightness", "Brightness:", 0.5, 2.5, 2, "Overall brightness of the ratio color image.")
    slider(f_ratio, "colorSmoothing", "Color smoothing:", 0.0, 10.0, 1,
           "Removes color speckle in faint areas without blurring detail. 2 px is a good default.")
    v_bl.addWidget(w_ratio)

    w_pal = QtWidgets.QWidget()
    v_pal = QtWidgets.QVBoxLayout(w_pal)
    v_pal.setContentsMargins(0, 0, 0, 0)
    f_pal = QtWidgets.QFormLayout()
    palette_combo = QtWidgets.QComboBox()
    palette_combo.addItems([p["name"] for p in PALETTES])
    palette_combo.setCurrentIndex(s["paletteIndex"])
    f_pal.addRow("Palette:", palette_combo)
    v_pal.addLayout(f_pal)
    g_w = QtWidgets.QGridLayout()
    weight_spins = [[None] * 3 for _ in range(3)]
    for c, chname in enumerate(["R =", "G =", "B ="]):
        g_w.addWidget(QtWidgets.QLabel(chname), c, 0)
        for k, suffix in enumerate([" * H +", " * O +", " * S"]):
            sp = QtWidgets.QDoubleSpinBox()
            sp.setRange(0.0, 2.0)
            sp.setDecimals(2)
            sp.setSingleStep(0.05)
            sp.setValue(s["paletteWeights"][c][k])

            def on_w(v, c=c, k=k):
                s["paletteWeights"][c][k] = float(v)
                schedule()
            sp.valueChanged.connect(on_w)
            weight_spins[c][k] = sp
            g_w.addWidget(sp, c, 1 + 2 * k)
            g_w.addWidget(QtWidgets.QLabel(suffix), c, 2 + 2 * k)
    v_pal.addLayout(g_w)
    v_bl.addWidget(w_pal)

    def refresh_weights():
        for c in range(3):
            for k in range(3):
                sp = weight_spins[c][k]
                sp.blockSignals(True); sp.setValue(s["paletteWeights"][c][k]); sp.blockSignals(False)

    def on_palette(i):
        s["paletteIndex"] = i
        s["paletteWeights"] = [r[:] for r in PALETTES[i]["w"]]
        refresh_weights()
        schedule()
    palette_combo.currentIndexChanged.connect(on_palette)

    w_custom = QtWidgets.QWidget()
    f_custom = QtWidgets.QFormLayout(w_custom)
    f_custom.setContentsMargins(0, 0, 0, 0)
    for key, label in [("customR", "R ="), ("customG", "G ="), ("customB", "B =")]:
        ed = QtWidgets.QLineEdit(s[key])
        ed.setToolTip("Formula using H, O and S (the stretched lines). Functions: min, max, sqrt, ln, exp, abs, pow, iif; ^ = power.")

        def on_edit(ed=ed, key=key):
            s[key] = ed.text()
            schedule()
        ed.editingFinished.connect(on_edit)
        f_custom.addRow(label, ed)
    v_bl.addWidget(w_custom)

    f_fin = QtWidgets.QFormLayout()
    slider(f_fin, "saturation", "Saturation:", 0.0, 3.0, 2, "Color strength (1 = unchanged). Brightness is not affected.")
    slider(f_fin, "greenReduction", "Green reduction (%):", 0, 100, 0, "Removes excess green, like SCNR. 70-100% for SHO.")
    checkbox(f_fin, "foraxxFinishing", "Foraxx finishing (hue and saturation curves)",
             "Reds pushed towards gold, blues deepened, gold and blue boosted (ForaxxPalette settings).")
    v_bl.addLayout(f_fin)
    left.addWidget(gb_bl)

    mode_widgets = {BLEND_RATIO: w_ratio, BLEND_PALETTE: w_pal, BLEND_CUSTOM: w_custom}

    def update_mode_widgets():
        for m, w in mode_widgets.items():
            w.setVisible(s["blendMode"] == m)

    def refresh_controls():
        for key, setter in setters.items():
            setter(s[key])
        refresh_weights()

    def on_mode(i):
        s["blendMode"] = i
        apply_mode_defaults(s)
        refresh_controls()
        update_mode_widgets()
        schedule()
    mode_combo.currentIndexChanged.connect(on_mode)
    update_mode_widgets()

    reset_row = QtWidgets.QHBoxLayout()
    reset_row.addStretch(1)
    reset_btn = QtWidgets.QPushButton("Reset all sliders")
    reset_btn.setToolTip("Puts every Stretch and Blend slider back to its default for the current mode.")

    def on_reset():
        reset_sliders(s)
        refresh_controls()
        schedule()
    reset_btn.clicked.connect(on_reset)
    reset_row.addWidget(reset_btn)
    left.addLayout(reset_row)

    gb_out = QtWidgets.QGroupBox("Output")
    v_out = QtWidgets.QVBoxLayout(gb_out)
    keep_cb = QtWidgets.QCheckBox("Keep stretched mono lines (_HA_s, _OIII_s, _SII_s)")
    keep_cb.setChecked(s["keepMono"])
    keep_cb.stateChanged.connect(lambda _st: s.__setitem__("keepMono", keep_cb.isChecked()))
    v_out.addWidget(keep_cb)
    left.addWidget(gb_out)
    left.addStretch(1)

    # ---- preview
    gb_pv = QtWidgets.QGroupBox("Preview")
    v_pv = QtWidgets.QVBoxLayout(gb_pv)
    top = QtWidgets.QHBoxLayout()
    top.addWidget(QtWidgets.QLabel("Show:"))
    show_combo = QtWidgets.QComboBox()
    show_combo.addItems(show_names)
    top.addWidget(show_combo)
    top.addSpacing(8)
    top.addWidget(QtWidgets.QLabel("Zoom:"))
    zoom_combo = QtWidgets.QComboBox()
    zoom_combo.addItems(["Fit", "100% (1:1)"])
    zoom_combo.setToolTip("Fit shows the whole image at screen resolution. 100% shows real pixels for judging noise "
                          "and detail: drag to pan. Double-click the preview to switch between them.")
    top.addWidget(zoom_combo)
    top.addSpacing(8)
    top.addWidget(QtWidgets.QLabel("Quality:"))
    quality_combo = QtWidgets.QComboBox()
    quality_combo.addItems(["Sharp", "Balanced", "Fast"])
    quality_combo.setToolTip("Sharp computes the preview at your screen's full resolution (recommended). "
                             "Balanced uses 70% (about half the work, slightly softer); Fast uses 50% "
                             "(quickest, visibly softer). Only needed on slower computers.")
    top.addWidget(quality_combo)
    live_cb = QtWidgets.QCheckBox("Live update")
    live_cb.setChecked(True)

    def on_live(_st):
        live["on"] = live_cb.isChecked()
        if live["on"]:
            schedule()
    live_cb.stateChanged.connect(on_live)
    top.addSpacing(12)
    top.addWidget(live_cb)
    top.addStretch(1)
    refresh_btn = QtWidgets.QPushButton("Refresh")
    refresh_btn.clicked.connect(lambda _c=False: schedule(True))
    top.addWidget(refresh_btn)
    v_pv.addLayout(top)
    warn_label = QtWidgets.QLabel("")
    warn_label.setStyleSheet("color: #f0a040;")
    warn_label.setWordWrap(True)
    warn_label.setVisible(False)
    v_pv.addWidget(warn_label)
    preview = PreviewLabel()
    preview.set_message("Choose the Ha and OIII images.")
    v_pv.addWidget(preview, 1)
    status = QtWidgets.QLabel("")
    v_pv.addWidget(status)
    columns.addWidget(gb_pv, 1)
    show_combo.currentIndexChanged.connect(lambda _i: schedule(True))
    view = {"zoom": 0, "center": None, "info": None}

    def on_zoom(i):
        view["zoom"] = i
        schedule(True)
    zoom_combo.currentIndexChanged.connect(on_zoom)
    quality_combo.currentIndexChanged.connect(lambda _i: schedule(True))

    def on_double_click(frac):
        info = view["info"]
        if view["zoom"] == 0 and frac is not None and info is not None and ctl.ready():
            h, w = ctl.images[L_HA].shape
            # the display is flipped vertically (FITS rows run bottom-up)
            view["center"] = (frac[0] * w, (1 - frac[1]) * h)
            zoom_combo.setCurrentIndex(1)
        elif view["zoom"] == 1:
            zoom_combo.setCurrentIndex(0)

    def on_drag(dx, dy):
        if view["zoom"] != 1 or view["info"] is None:
            return
        cx, cy = view["center"] if view["center"] else view["info"]["center"]
        # drag like a map: moving the image right shows what is to the left;
        # screen y runs down while image rows run up
        view["center"] = (cx - dx, cy + dy)
        schedule(True)

    preview.on_double_click = on_double_click
    preview.on_drag = on_drag
    preview.on_resized = lambda: schedule(True)

    def update_preview():
        import time
        t0 = time.time()
        if not ctl.ready():
            preview.set_message("Choose the Ha and OIII images.")
            warn_label.setVisible(False)
            status.setText("")
            return
        try:
            if ctl.preview_src is None:
                preview.set_message("Measuring the images (first time only)...")
                QtWidgets.QApplication.processEvents()
            dw, dh = preview.device_size()
            q = [1.0, 0.7, 0.5][quality_combo.currentIndex()] if view["zoom"] == 0 else 1.0
            dw, dh = int(dw * q), int(dh * q)
            rgb8, warning, info = ctl.preview(show_combo.currentIndex(), dw, dh, view["zoom"], view["center"])
            view["info"] = info
            if info["zoom"] == 1:
                view["center"] = info["center"]
            h, w = rgb8.shape[:2]
            qimg = QtGui.QImage(rgb8.data, w, h, 3 * w, QtGui.QImage.Format.Format_RGB888).copy()
            preview.set_image(QtGui.QPixmap.fromImage(qimg), info["zoom"] == 0)
            warn_label.setText("Warning: " + warning if warning else "")
            warn_label.setVisible(bool(warning))
            if info["zoom"] == 1:
                status.setText("Preview at 100%% (1:1), %dx%d pixels - drag to pan, double-click to fit  (%.1f s)" %
                               (info["w"], info["h"], time.time() - t0))
            else:
                status.setText("Preview fit to screen at 1:%.1f - double-click to zoom to 100%% there  (%.1f s)" %
                               (info["factor"], time.time() - t0))
        except Exception as e:
            preview.set_message("Preview error: %s" % e)
            warn_label.setVisible(False)
            status.setText("")
    timer.timeout.connect(update_preview)

    # ---- help, apply, close
    def on_help():
        dlg = QtWidgets.QDialog(win)
        dlg.setWindowTitle("%s %s - Guide" % (TITLE, VERSION))
        dlg.resize(760, 680)
        lay = QtWidgets.QVBoxLayout(dlg)
        tb = QtWidgets.QTextBrowser()
        tb.setOpenExternalLinks(True)
        tb.setHtml(guide_html())
        tb.moveCursor(QtGui.QTextCursor.MoveOperation.Start)   # open at the top
        tb.verticalScrollBar().setValue(0)
        lay.addWidget(tb)
        bb = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.StandardButton.Close)
        bb.rejected.connect(dlg.reject)
        lay.addWidget(bb)
        dlg.exec()

    def on_apply():
        if not ctl.ready():
            QtWidgets.QMessageBox.warning(win, TITLE, "Choose at least the Ha and OIII images.")
            return
        QtWidgets.QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            QtWidgets.QApplication.processEvents()
            ctl.apply()
        except Exception as e:
            ctl.log("%s error: %s" % (TITLE, e))
            QtWidgets.QMessageBox.critical(win, TITLE, "Processing failed:\n%s" % e)
        finally:
            QtWidgets.QApplication.restoreOverrideCursor()
            try:
                siril.reset_progress()
            except Exception:
                pass

    buttons = QtWidgets.QHBoxLayout()
    help_btn = QtWidgets.QPushButton("Help")
    help_btn.clicked.connect(lambda _c=False: on_help())
    buttons.addWidget(help_btn)
    buttons.addStretch(1)
    apply_btn = QtWidgets.QPushButton("Apply")
    apply_btn.setDefault(True)
    apply_btn.clicked.connect(lambda _c=False: on_apply())
    buttons.addWidget(apply_btn)
    close_btn = QtWidgets.QPushButton("Close")
    close_btn.clicked.connect(lambda _c=False: win.close())
    buttons.addWidget(close_btn)
    outer.addLayout(buttons)

    win.resize(1280, 760)
    win.show()
    app.exec()


def main():
    try:
        import sirilpy as s
    except ImportError:
        print("This script must be run from Siril 1.4 or newer (Scripts menu).")
        return
    s.ensure_installed("numpy", "scipy", "PyQt6")
    import_numeric()
    siril = s.SirilInterface()
    try:
        siril.connect()
    except Exception as e:
        print("Could not connect to Siril: %s" % e)
        return
    try:
        siril.cmd("requires", "1.4.0")
    except Exception as e:
        try:
            siril.log("%s needs Siril 1.4.0 or newer (%s)" % (TITLE, e))
        except Exception:
            pass
        return
    try:
        siril.log("%s %s by %s - %s" % (TITLE, VERSION, AUTHOR, HOME_URL))
    except Exception:
        pass
    run_gui(siril)


if __name__ == "__main__":
    main()
