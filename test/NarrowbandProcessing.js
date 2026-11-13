/******************************************************************************
 * NarrowbandProcessing.js - version 1.1.2 (November 2026)
 *
 * Stretching and blending of narrowband line images (Ha, OIII and optional
 * SII) into color images, with a live preview.
 *
 * Stretch
 *  - Black point per line from the real sky (robust background and noise
 *    estimates) instead of the single darkest pixel, with a clipping guard
 *    for nebulae that fill the frame.
 *  - Midtone stretch to a target median; line linking from independent
 *    (equal medians) to fully linked (true relative brightness).
 *  - Neutral background, contrast S-curve and highlight protection
 *    (arcsinh blend for bright cores such as M42).
 *
 * Blend
 *  - Foraxx (dynamic) HOO / SHO, ratio color (with presets, automatic
 *    balance and color smoothing), classic palettes with editable weights,
 *    and custom PixelMath.
 *  - Saturation, green reduction (SCNR-style) and Foraxx finishing (hue and
 *    saturation curves; curve settings from Paul Hancock's ForaxxPalette
 *    utility, applied with PixInsight's own processes).
 *
 * All per-pixel math is written as plain PixelMath expressions so it can be
 * ported to Siril.
 *
 * Version history
 *  0.1 - 0.5.3  Development versions (stretch engine, blending, Foraxx
 *               finishing, contrast, color smoothing, live preview, reset,
 *               highlight protection, green reduction, help guide).
 *  1.0          First public release. Help guide opens at the top;
 *               packaged as a PixInsight update repository.
 *  1.1          Sharp preview computed at the panel's real screen
 *               resolution and recomputed on resize; Zoom Fit / 100% (1:1)
 *               with double-click and drag to pan; Quality Sharp / Balanced
 *               / Fast. American spelling (color, center, gray); process
 *               icons saved by 1.0 still load.
 *  1.1.1        Digitally signed (Certified PixInsight Developer); no
 *               changes to processing.
 *  1.1.2        Fixed an error message and a possible PixInsight crash
 *               when settings changed (or the window closed) while the
 *               preview was still updating:
 *               only one preview update runs at a time and changes made
 *               meanwhile are applied when it finishes.
 *               Fixed a color cast and over-bright lines when some lines
 *               had noise reduction applied before the script: the link
 *               gain is now kept consistent with the black point. Apply no
 *               longer shows the stretched lines briefly when they are not
 *               kept, and leaves nothing behind if the blend fails.
 *
 * Copyright (C) 2026 Justin Pickens
 *
 * ----------------------------------------------------------------------------
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program.  If not, see <http://www.gnu.org/licenses/>.
 * ----------------------------------------------------------------------------
 *****************************************************************************/

#feature-id NarrowbandProcessing : Utilities > NarrowbandProcessing
#feature-info Stretching and blending of narrowband Ha / OIII / SII line images into HOO, SHO and Foraxx color images, with a live preview.<br/>Copyright &copy; 2026 Justin Pickens. GPL v3.

#include <pjsr/DataType.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/UndoFlag.jsh>

#define VERSION "1.1.2"
#define TITLE "NarrowbandProcessing"

// Line indices
#define L_HA 0
#define L_OIII 1
#define L_SII 2

var LINE_NAMES = ["Ha", "OIII", "SII"];
var LINE_INPUT_BASES = ["_HA", "_OIII", "_SII"];
var LINE_OUTPUT_IDS = ["_HA_s", "_OIII_s", "_SII_s"];


/*
 * General helpers
 */
function isValidView(view)
{
   return view != null && view != undefined && !view.isNull;
}

function isValidWindow(window)
{
   return window != null && window != undefined && !window.isNull;
}

function idInUse(id)
{
   return isValidWindow(ImageWindow.windowById(id)) || isValidView(View.viewById(id));
}

function uniqueId(base)
{
   if (!idInUse(base))
      return base;
   for (var n = 1; n < 1000; ++n)
      if (!idInUse(base + n))
         return base + n;
   return base + "_" + Math.floor(Math.random() * 1e6);
}

function sameGeometry(v1, v2)
{
   if (!isValidView(v1) || !isValidView(v2))
      return false;
   return v1.image.width == v2.image.width && v1.image.height == v2.image.height;
}

function copyAstrometricSolution(sourceView, targetId)
{
   try
   {
      if (!isValidView(sourceView) || !sourceView.window.hasAstrometricSolution)
         return;
      var target = View.viewById(targetId);
      if (isValidView(target) && sameGeometry(sourceView, target))
         target.window.copyAstrometricSolution(sourceView.window);
   }
   catch (e)
   {
   }
}

// Number for PixelMath expressions; negatives in parentheses so "a - -b" never occurs
function fmt(x)
{
   var t = x.toFixed(10);
   return x < 0 ? "(" + t + ")" : t;
}

/*
 * Pick the most recent view named like base, base1, base2, ... (DBXtract output)
 */
function autoPickView(base)
{
   var best = null, bestN = -1;
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i)
   {
      var id = windows[i].mainView.id;
      if (id.indexOf(base) != 0)
         continue;
      var rest = id.substring(base.length);
      if (rest.length > 0 && !/^[0-9]+$/.test(rest))
         continue;
      var n = rest.length > 0 ? parseInt(rest, 10) : 0;
      if (n > bestN)
      {
         bestN = n;
         best = windows[i].mainView;
      }
   }
   return best;
}


/*
 * ROBUST STATISTICS (shared with DBXtract 2.x)
 */

// Statistics ignore a 3% border, where registration leaves partial edge data
function innerRect(img)
{
   var mx = Math.floor(img.width * 0.03), my = Math.floor(img.height * 0.03);
   return new Rect(mx, my, img.width - mx, img.height - my);
}

function nativeClippedStats(img, lo, hi)
{
   try
   {
      img.selectedRect = innerRect(img);
      img.rangeClippingEnabled = true;
      img.rangeClipLow = lo;
      img.rangeClipHigh = hi;
      var med = img.median();
      var sigma = 1.4826 * img.MAD(med);
      return { median: med, sigma: sigma };
   }
   finally
   {
      // Never leave the user's image with a selection or range clipping set
      img.rangeClippingEnabled = false;
      img.resetSelections();
   }
}

function sampledClippedStats(img, lo, hi)
{
   var step = Math.max(1, Math.floor(Math.sqrt(img.width * img.height / 250000)));
   var r = innerRect(img);
   var v = [];
   for (var y = r.y0; y < r.y1; y += step)
      for (var x = r.x0; x < r.x1; x += step)
      {
         var s = img.sample(x, y, 0);
         if (s > lo && s < hi)
            v.push(s);
      }
   if (v.length == 0)
      return { median: 0, sigma: 0 };
   v.sort(function (a, b) { return a - b; });
   var med = v[v.length >> 1];
   var d = [];
   for (var i = 0; i < v.length; ++i)
      d.push(Math.abs(v[i] - med));
   d.sort(function (a, b) { return a - b; });
   return { median: med, sigma: 1.4826 * d[d.length >> 1] };
}

function clippedStats(img, lo, hi)
{
   try
   {
      return nativeClippedStats(img, lo, hi);
   }
   catch (e)
   {
      return sampledClippedStats(img, lo, hi);
   }
}

function readRow(img, y, buffer)
{
   try
   {
      img.getSamples(buffer, new Rect(0, y, img.width, y + 1), 0);
      return buffer;
   }
   catch (e)
   {
      for (var x = 0; x < img.width; ++x)
         buffer[x] = img.sample(x, y, 0);
      return buffer;
   }
}

// Noise from differences between pixels two columns apart (immune to smooth nebulosity)
function differenceNoise(img)
{
   var rowStep = Math.max(1, Math.floor(img.height / 400));
   var d = [];
   var row = new Float32Array(img.width);
   for (var y = 0; y < img.height; y += rowStep)
   {
      readRow(img, y, row);
      for (var x = 0; x + 2 < img.width; x += 3)
      {
         var a = row[x], b = row[x + 2];
         if (a > 1.0e-7 && b > 1.0e-7 && a < 0.9 && b < 0.9)
            d.push(Math.abs(a - b));
      }
   }
   if (d.length < 100)
      return 0;
   d.sort(function (p, q) { return p - q; });
   return d[d.length >> 1] / (0.6745 * Math.SQRT2);
}

/*
 * Sky level from the faintest pixels: the 3.125th percentile of Gaussian noise
 * sits 1.863 sigma below the background, so with the noise known this needs
 * only ~3% of the frame near true sky (suits frame-filling nebulae).
 */
function robustBackground(view)
{
   var img = view.image;
   var lo = 1.0e-7;
   var sigma = differenceNoise(img);
   var q = clippedStats(img, lo, 1.0).median;
   for (var i = 0; i < 4; ++i)
      q = clippedStats(img, lo, q).median;
   if (!(sigma > 1.0e-9))
   {
      var s = clippedStats(img, lo, 1.0);
      return { background: s.median, sigma: Math.max(s.sigma, 1.0e-9) };
   }
   return { background: q + 1.8627 * sigma, sigma: sigma };
}

// Low percentile by repeated halving: n halvings gives the 100/2^n percentile
function lowQuantile(view, halvings)
{
   var img = view.image;
   var q = clippedStats(img, 1.0e-7, 1.0).median;
   for (var i = 1; i < halvings; ++i)
   {
      var next = clippedStats(img, 1.0e-7, q).median;
      if (!(next > 0) || next >= q)
         break;
      q = next;
   }
   return q;
}

// Share of pixels below value p of the way up (strided sample, ~250k pixels)
function sampleQuantile(view, p)
{
   var img = view.image;
   var step = Math.max(1, Math.floor(Math.sqrt(img.width * img.height / 250000)));
   var r = innerRect(img);
   var v = [];
   var row = new Float32Array(img.width);
   for (var y = r.y0; y < r.y1; y += step)
   {
      readRow(img, y, row);
      for (var x = r.x0; x < r.x1; x += step)
         if (row[x] > 1.0e-7) v.push(row[x]);
   }
   if (v.length == 0)
      return 0;
   v.sort(function (a, b) { return a - b; });
   return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

// Standard normal tail: share of Gaussian noise more than k sigma below the mean
function normalTail(k)
{
   var x = k / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
   var erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
   return 0.5 * erfc;
}

function imageMedian(view)
{
   return clippedStats(view.image, 1.0e-7, 1.0).median;
}


/*
 * STRETCH ENGINE
 *
 * For each line:
 *    x  = (L - BP) / (1 - BP), clipped to [0, 1]      BP = sky - clip * sigma
 *    x' = min(1, g * x)                              g  = link gain (below)
 *    y  = MTF(x'; m)                                 one shared midtone m
 * with MTF(x; m) = (m - 1) x / ((2m - 1) x - m), which maps x0 to T when
 * m = x0 (1 - T) / (x0 + T - 2 T x0).
 *
 * The reference line is Ha: m is chosen so Ha's reference brightness
 * (median above its black point) lands on the target T. Each other line gets
 * the gain g = (x0_Ha / x0_line) ^ (1 - link): at link = 1 every line uses the
 * same curve (relative brightness kept); at link = 0 its median also lands on T.
 */
function midtonesFor(x0, target)
{
   x0 = Math.max(1.0e-9, Math.min(0.999999, x0));
   return x0 * (1 - target) / (x0 + target - 2 * target * x0);
}

function mtf(x, m)
{
   if (x <= 0) return 0;
   if (x >= 1) return 1;
   return (m - 1) * x / ((2 * m - 1) * x - m);
}

/*
 * Line measurements (sky, noise, median and a sorted pixel sample) depend only
 * on the image, not on the settings, so they are measured once per image and
 * cached. The preview and Apply then use identical black points and gains.
 * The cache is cleared when the dialog opens.
 */
var MEASURE_CACHE = {};

function clearMeasureCache()
{
   MEASURE_CACHE = {};
}

function sortedSample(view)
{
   var img = view.image;
   var step = Math.max(1, Math.floor(Math.sqrt(img.width * img.height / 250000)));
   var r = innerRect(img);
   var v = [];
   var row = new Float32Array(img.width);
   for (var y = r.y0; y < r.y1; y += step)
   {
      readRow(img, y, row);
      for (var x = r.x0; x < r.x1; x += step)
         if (row[x] > 1.0e-7) v.push(row[x]);
   }
   v.sort(function (a, b) { return a - b; });
   return v;
}

function measureLine(view)
{
   var key = view.id + "|" + view.image.width + "x" + view.image.height;
   if (MEASURE_CACHE[key])
      return MEASURE_CACHE[key];
   var bg = robustBackground(view);
   var m = { sky: bg.background, sigma: bg.sigma, median: imageMedian(view), sample: sortedSample(view) };
   MEASURE_CACHE[key] = m;
   return m;
}

function sampleAt(sample, p)
{
   if (sample.length == 0) return 0;
   return sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * sample.length)))];
}

// Share of the sample at or below a value (binary search)
function fractionBelow(sample, value)
{
   var lo = 0, hi = sample.length;
   while (lo < hi)
   {
      var mid = (lo + hi) >> 1;
      if (sample[mid] <= value) lo = mid + 1; else hi = mid;
   }
   return sample.length > 0 ? lo / sample.length : 0;
}

// Black point and reference brightness per line, for the current settings
function analyzeLines(lines, settings)
{
   var info = [];
   for (var i = 0; i < lines.length; ++i)
   {
      var v = lines[i].view;
      var m = measureLine(v);
      var bp = Math.max(0, m.sky - settings.shadowClip * m.sigma);
      // Clipping guard: when no true sky is visible (frame-filling nebula), the
      // sky estimate sits above the darkest dust. Allow about twice the clipping
      // that pure sky noise would give at this shadow clip (at least 0.05%), so
      // the guard only acts when the sky estimate is clearly too high.
      var allowed = Math.max(0.0005, 2 * normalTail(settings.shadowClip));
      var floorValue = sampleAt(m.sample, allowed);
      var guarded = false;
      if (floorValue > 0 && bp > floorValue)
      {
         bp = floorValue;
         guarded = true;
      }
      var x0 = (m.median - bp) / (1 - bp);
      if (!(x0 > 0))
         x0 = Math.max(1.0e-6, (m.sigma * settings.shadowClip) / (1 - bp));
      info.push({ line: lines[i].line, view: v, sky: m.sky, sigma: m.sigma, bp: bp, median: m.median, x0: x0,
                  guarded: guarded, floorValue: floorValue, sample: m.sample });
   }
   return info;
}

// Stretch parameters from the analysis: shared midtone and per-line gains
function stretchParameters(info, settings)
{
   var ref = info[0];   // Ha is always first
   var m = midtonesFor(ref.x0, settings.targetMedian);
   var link = Math.max(0, Math.min(1, settings.link / 100));
   for (var i = 0; i < info.length; ++i)
   {
      info[i].gain = Math.pow(ref.x0 / info[i].x0, 1 - link);
      info[i].m = m;
   }

   /*
    * Neutral background: place each other line's black point so its sky lands
    * at the same stretched level as Ha's sky, i.e. gain * (sky - BP) equals
    * Ha's (sky - BP). Without this, a line with less noise than Ha gets a
    * darker sky after the stretch and the background takes on a tint. The
    * clipping guard still applies.
    */
   if (settings.neutralBackground)
   {
      // Anchor: the sky, or - when Ha's black point was set by the clipping
      // guard (no true sky, e.g. a frame-filling nebula) - each line's darkest
      // pixels, so the darkest regions are matched instead.
      var useFloor = ref.guarded;
      var refAnchor = useFloor ? ref.floorValue : ref.sky;
      var refOffset = Math.max(0, (refAnchor - ref.bp) / (1 - ref.bp));
      for (i = 1; i < info.length; ++i)
      {
         var p = info[i];
         var anchor = useFloor ? p.floorValue : p.sky;
         /*
          * The black point depends on the gain and the gain (through the
          * median above the black point) on the black point. Normally one
          * pass agrees to within a few percent, and is left as it is. It does
          * not when a line's measured noise is unrepresentative - typically
          * after noise reduction, which leaves a first black point so close
          * to the sky that the gain comes out several times too high. Then
          * repeat until the gain agrees with the black point it produced to
          * within 10%, so the line's median lands near its target and its
          * sky on Ha's. (Iterating further would only drift along a
          * direction the data does not determine in sparse fields.)
          */
         for (var pass = 0; pass < 60; ++pass)
         {
            var bp = Math.max(0, anchor - refOffset * (1 - p.bp) / p.gain);
            p.guarded = false;
            if (p.floorValue > 0 && bp > p.floorValue)
            {
               bp = p.floorValue;
               p.guarded = true;
            }
            p.bp = bp;
            p.x0 = Math.max(1.0e-6, (p.median - bp) / (1 - bp));
            var consistentGain = Math.pow(ref.x0 / p.x0, 1 - link);
            if (Math.abs(Math.log(consistentGain / p.gain)) < 0.10)
               break;
            p.gain = consistentGain;
         }
      }
   }

   /*
    * Highlight protection: blend the midtone curve with an arcsinh (log-like)
    * curve that maps the same reference median to the target, but keeps far
    * more separation in the highlights. One curve shared by all lines; its top
    * (X) is the brightest line's maximum, so nothing clips at the top.
    */
   var w = Math.max(0, Math.min(100, settings.highlightProtection || 0)) / 100;
   var X = 1, bArc = 1;
   if (w > 0)
   {
      for (i = 0; i < info.length; ++i)
      {
         var smp = info[i].sample;
         var top = smp.length > 0 ? smp[smp.length - 1] : 1;
         X = Math.max(X, info[i].gain * (top - info[i].bp) / (1 - info[i].bp));
      }
      bArc = arcsinhSoftening(ref.x0, settings.targetMedian, X);
   }
   for (i = 0; i < info.length; ++i)
   {
      info[i].hpW = w;
      info[i].hpX = X;
      info[i].hpB = bArc;
      info[i].expectedMedian = stretchValue(info[i].gain * info[i].x0, info[i], settings);
   }
   return info;
}

// PixelMath expression for one line (portable: plain arithmetic, min, max)
/*
 * Contrast: an S-curve pivoting on the target median, identical for every line
 *    y <= p:  p * (y / p) ^ g                 (shadows and dust lanes darker)
 *    y >  p:  1 - (1 - p) * ((1 - y) / (1 - p)) ^ g   (mid-tones spread out)
 * It keeps 0, 1 and the pivot fixed, so the median and (with neutral
 * background) the sky level are unchanged. g = 1 + contrast / 100.
 */
function contrastGamma(settings)
{
   return 1 + Math.max(0, Math.min(100, settings.contrast)) / 100;
}

// gLow for the shadow half, gHigh for the highlight half
function contrastCurve(y, pivot, gLow, gHigh)
{
   if (gHigh === undefined) gHigh = gLow;
   if (y <= pivot) return gLow <= 1.000001 ? y : pivot * Math.pow(y / pivot, gLow);
   return gHigh <= 1.000001 ? y : 1 - (1 - pivot) * Math.pow((1 - y) / (1 - pivot), gHigh);
}

// Highlight protection eases off the highlight half of the contrast curve
function contrastGammaHigh(settings, w)
{
   return 1 + (contrastGamma(settings) - 1) * (1 - w);
}

function asinh(z)
{
   return Math.log(z + Math.sqrt(z * z + 1));
}

// Softening b so that asinh(x0 / b) / asinh(X / b) = T (bisection on log b)
function arcsinhSoftening(x0, T, X)
{
   x0 = Math.max(1.0e-9, x0);
   if (x0 / X >= T)
      return 1.0e6;   // already bright enough: almost linear
   var lo = Math.log(1.0e-12), hi = Math.log(1.0e6);
   for (var i = 0; i < 100; ++i)
   {
      var mid = 0.5 * (lo + hi), b = Math.exp(mid);
      var r = asinh(x0 / b) / asinh(X / b);
      if (r < T) hi = mid; else lo = mid;   // smaller b gives a higher ratio
   }
   return Math.exp(0.5 * (lo + hi));
}

// The full per-line curve as numbers (for reports and checks); x is relative to the black point
function stretchValue(x, p, settings)
{
   var ym = mtf(Math.min(1, Math.max(0, x)), p.m);
   var y = ym;
   if (p.hpW > 0)
   {
      var ya = asinh(Math.min(p.hpX, Math.max(0, x)) / p.hpB) / asinh(p.hpX / p.hpB);
      y = (1 - p.hpW) * ym + p.hpW * ya;
   }
   return contrastCurve(y, settings.targetMedian, contrastGamma(settings), contrastGammaHigh(settings, p.hpW || 0));
}

// PixelMath asinh, written with ln and sqrt so it ports to Siril as is
function asinhExpr(z)
{
   return "ln(" + z + " + sqrt(" + z + " * " + z + " + 1))";
}

function stretchExpression(sourceId, p, settings)
{
   var xr = "(" + fmt(p.gain / (1 - p.bp)) + " * (" + sourceId + " - " + fmt(p.bp) + "))";
   var x = "min(max(" + xr + ", 0), 1)";
   // MTF(x; m) = (m - 1) x / ((2m - 1) x - m)
   var y = "((" + fmt(p.m - 1) + " * " + x + ") / (" + fmt(2 * p.m - 1) + " * " + x + " - " + fmt(p.m) + "))";
   var w = p.hpW || 0;
   if (w > 0)
   {
      var xa = "(min(max(" + xr + ", 0), " + fmt(p.hpX) + ") / " + fmt(p.hpB) + ")";
      var ya = "(" + asinhExpr(xa) + " / " + fmt(asinh(p.hpX / p.hpB)) + ")";
      y = "(" + fmt(1 - w) + " * " + y + " + " + fmt(w) + " * " + ya + ")";
   }
   var gLow = contrastGamma(settings), gHigh = contrastGammaHigh(settings, w);
   if (gLow <= 1.000001 && gHigh <= 1.000001)
      return y;
   var piv = settings.targetMedian;
   var low = gLow <= 1.000001 ? y : fmt(piv) + " * (" + y + " / " + fmt(piv) + ") ^ " + fmt(gLow);
   var high = gHigh <= 1.000001 ? y : "1 - " + fmt(1 - piv) + " * ((1 - " + y + ") / " + fmt(1 - piv) + ") ^ " + fmt(gHigh);
   return "iif(" + y + " <= " + fmt(piv) + ", " + low + ", " + high + ")";
}

function pixelMathNew(referenceView, expression, newId, hidden)
{
   var P = new PixelMath;
   P.expression = expression;
   P.useSingleExpression = true;
   P.symbols = "";
   P.generateOutput = true;
   P.singleThreaded = false;
   P.optimization = true;
   P.use64BitWorkingImage = false;
   P.rescale = false;
   P.truncate = true;
   P.truncateLower = 0;
   P.truncateUpper = 1;
   P.createNewImage = true;
   P.showNewImage = !hidden;
   P.newImageId = newId;
   P.newImageWidth = 0;
   P.newImageHeight = 0;
   P.newImageAlpha = false;
   P.newImageColorSpace = PixelMath.prototype.Gray;
   P.newImageSampleFormat = PixelMath.prototype.f32;
   P.executeOn(referenceView, false);
   return View.viewById(newId);
}

// The selected input lines, checked: [{ line, view }]
function inputLines(settings)
{
   var lines = [];
   if (!isValidView(settings.ha) || !isValidView(settings.oiii))
      throw new Error("Select at least the Ha and OIII images.");
   lines.push({ line: L_HA, view: settings.ha });
   lines.push({ line: L_OIII, view: settings.oiii });
   if (isValidView(settings.sii))
      lines.push({ line: L_SII, view: settings.sii });
   for (var i = 0; i < lines.length; ++i)
   {
      if (lines[i].view.image.numberOfChannels != 1)
         throw new Error(lines[i].view.id + " is not a mono (grayscale) image.");
      if (i > 0 && !sameGeometry(lines[0].view, lines[i].view))
         throw new Error(lines[i].view.id + " has different dimensions from " + lines[0].view.id + ".");
   }
   return lines;
}

function logSettings(settings)
{
   Console.noteln("Settings");
   Console.writeln("  inputs: Ha ", settings.ha.id, ", OIII ", settings.oiii.id,
                   isValidView(settings.sii) ? ", SII " + settings.sii.id : ", no SII");
   Console.writeln(format("  stretch: shadow clip %.1f, target median %.3f, link %d%%, contrast %d, highlight protection %d, neutral background %s",
                          settings.shadowClip, settings.targetMedian, Math.round(settings.link), Math.round(settings.contrast),
                          Math.round(settings.highlightProtection || 0), settings.neutralBackground ? "on" : "off"));
   Console.writeln(format("  blend: %s, saturation %.2f, green reduction %d%%, Foraxx finishing %s, keep mono lines %s",
                          BLEND_NAMES[(settings.blendMode >= 0 && settings.blendMode < BLEND_NAMES.length) ? settings.blendMode : 0],
                          settings.saturation, Math.round(settings.greenReduction || 0), settings.foraxxFinishing ? "on" : "off",
                          settings.keepMono ? "on" : "off"));
}

/*
 * Run the stretch: returns [{ line, id }] of the stretched mono images.
 * opts (optional):
 *    sources: { line: view } images to apply the stretch to (default: the
 *             inputs themselves; the preview passes downsampled copies)
 *    hidden:  create the outputs as hidden temporary images
 *    quiet:   no console report
 * Black points and gains always come from the full-resolution inputs.
 */
function stretchLines(settings, opts)
{
   opts = opts || {};
   var lines = inputLines(settings);
   if (!opts.quiet)
   {
      logSettings(settings);
      Console.noteln("Analyzing lines");
   }
   var info = stretchParameters(analyzeLines(lines, settings), settings);

   if (!opts.quiet)
      Console.writeln(format("  shadow clip %.1f sigma, target median %.3f, link %d%%, midtones %.6f",
                             settings.shadowClip, settings.targetMedian, Math.round(settings.link), info[0].m));
   var results = [];
   for (var i = 0; i < info.length; ++i)
   {
      var p = info[i];
      if (!opts.quiet)
         Console.writeln(format("  %-4s sky %.3e  noise %.3e  black point %.3e%s  median %.3e  gain %.3f  -> median %.3f  (%.2f%% at black)",
                                LINE_NAMES[p.line], p.sky, p.sigma, p.bp, p.guarded ? " (guarded)" : "", p.median, p.gain,
                                p.expectedMedian, 100 * fractionBelow(p.sample, p.bp)));
      var src = (opts.sources && opts.sources[p.line]) ? opts.sources[p.line] : p.view;
      var id = uniqueId(opts.hidden ? "nbp_" + LINE_NAMES[p.line] : LINE_OUTPUT_IDS[p.line]);
      var out = pixelMathNew(src, stretchExpression(src.id, p, settings), id, opts.hidden);
      if (!isValidView(out))
         throw new Error("Could not create " + id + " from " + src.id + ".");
      if (!opts.hidden)
      {
         copyAstrometricSolution(p.view, id);
         Console.writeln("  created ", id);
      }
      results.push({ line: p.line, id: id });
   }
   return results;
}

/*
 * BLEND ENGINE
 *
 * All modes produce three PixelMath expressions (R, G, B) in terms of the
 * stretched line images, so the same math can be reused in a Siril port.
 * Symbols: H = Ha, O = OIII, S = SII (stretched, 0..1).
 */
#define BLEND_FORAXX 0
#define BLEND_RATIO 1
#define BLEND_PALETTE 2
#define BLEND_CUSTOM 3

var BLEND_NAMES = ["Foraxx (dynamic)", "Ratio color", "Classic palette", "Custom PixelMath"];

// Ratio color presets: color for Ha-dominant and OIII-dominant signal
var RATIO_PRESETS = [
   { name: "Gold + blue core", ha: [1.00, 0.70, 0.28], oiii: [0.30, 0.62, 1.00] },
   { name: "Copper + teal",    ha: [1.00, 0.48, 0.22], oiii: [0.20, 0.78, 0.80] },
   { name: "Red + cyan",       ha: [1.00, 0.22, 0.16], oiii: [0.25, 0.90, 1.00] },
   { name: "Amber + blue",     ha: [1.00, 0.60, 0.10], oiii: [0.15, 0.45, 1.00] }
];
// SII color in ratio mode (red-orange)
var RATIO_SII_COLOR = [1.00, 0.30, 0.18];

// Classic palettes: rows R, G, B; columns H, O, S
var PALETTES = [
   { name: "HOO", w: [[1, 0, 0], [0, 1, 0], [0, 1, 0]] },
   { name: "HOO (green from Ha + OIII)", w: [[1, 0, 0], [0.4, 0.6, 0], [0, 1, 0]] },
   { name: "SHO", w: [[0, 0, 1], [1, 0, 0], [0, 1, 0]] },
   { name: "HSO", w: [[1, 0, 0], [0, 0, 1], [0, 1, 0]] },
   { name: "HOS", w: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }
];

function inv(x) { return "(1 - " + x + ")"; }

// Foraxx dynamic factor f(x) = x ^ (1 - x)
function foraxxFactor(x) { return "((" + x + ") ^ " + inv(x) + ")"; }

function foraxxExpressions(H, O, S)
{
   var fHO = foraxxFactor(H + " * " + O);
   var G = "(" + fHO + " * " + H + " + " + inv(fHO) + " * " + O + ")";
   if (S == null)
      return { R: H, G: G, B: O };   // HOO (as ForaxxPalette)
   // SHO (as ForaxxPalette): R mixes SII and Ha by an OIII-driven factor
   var fO = foraxxFactor(O);
   var R = "(" + fO + " * " + S + " + " + inv(fO) + " * " + H + ")";
   return { R: R, G: G, B: O };
}

/*
 * Ratio color: t = how OIII-dominated a pixel is (0 = Ha, 1 = OIII), centered
 * on the nebula's typical ratio and sharpened by "contrast". Color blends from
 * the Ha color to the OIII color; SII (when present) pulls toward red-orange.
 * Brightness is the brightest line, so structure from every line is kept.
 */
// cH, cO, cS: images the color is computed from (smoothed copies when color
// smoothing is on); H, O, S: full-resolution images for brightness
function ratioExpressions(H, O, S, settings, center, cH, cO, cS)
{
   cH = cH || H; cO = cO || O; cS = cS || S;
   var preset = RATIO_PRESETS[(settings.ratioPreset >= 0 && settings.ratioPreset < RATIO_PRESETS.length) ? settings.ratioPreset : 0];
   var eps = "0.000001";
   var r = "(" + cO + " / (" + cH + " + " + cO + " + " + eps + "))";
   var c = center - settings.ratioBalance / 100 * 0.25;
   var t = "min(max(0.5 + " + fmt(settings.ratioContrast) + " * (" + r + " - " + fmt(c) + "), 0), 1)";
   var u = null;
   if (S != null)
      u = "min(max(" + fmt(settings.siiStrength) + " * " + cS + " / (" + cH + " + " + cS + " + " + eps + "), 0), 1)";
   var L = S != null ? "max(" + H + ", " + O + ", " + S + ")" : "max(" + H + ", " + O + ")";
   // The tint colors are darker than white, so brightness is scaled back up
   L = "(" + fmt(settings.ratioBrightness) + " * " + L + ")";

   function channel(k)
   {
      var col = "(" + fmt(preset.ha[k]) + " * " + inv(t) + " + " + fmt(preset.oiii[k]) + " * " + t + ")";
      if (u != null)
         col = "(" + col + " * " + inv(u) + " + " + fmt(RATIO_SII_COLOR[k]) + " * " + u + ")";
      return "(" + L + " * " + col + ")";
   }
   return { R: channel(0), G: channel(1), B: channel(2) };
}

function paletteExpressions(H, O, S, weights)
{
   var src = [H, O, S];
   var out = [];
   for (var c = 0; c < 3; ++c)
   {
      var terms = [];
      for (var k = 0; k < 3; ++k)
      {
         var w = weights[c][k];
         if (w == 0 || (k == 2 && S == null)) continue;
         terms.push(fmt(w) + " * " + src[k]);
      }
      out.push(terms.length > 0 ? "(" + terms.join(" + ") + ")" : "0");
   }
   return { R: out[0], G: out[1], B: out[2] };
}

// Replace the symbols H, O, S in a user expression with image identifiers
function substituteSymbols(expr, H, O, S)
{
   return expr.replace(/\b([HOS])\b/g, function (m, sym)
   {
      if (sym == "H") return H;
      if (sym == "O") return O;
      if (S == null) throw new Error("The custom expression uses S, but no SII image is selected.");
      return S;
   });
}

// Typical OIII/(Ha+OIII) ratio over the brighter half of the nebula (auto balance center)
function typicalRatio(hView, oView)
{
   var hi = hView.image, oi = oView.image;
   var step = Math.max(1, Math.floor(Math.sqrt(hi.width * hi.height / 200000)));
   var rowH = new Float32Array(hi.width), rowO = new Float32Array(oi.width);
   var lum = [], rat = [];
   for (var y = 0; y < hi.height; y += step)
   {
      readRow(hi, y, rowH);
      readRow(oi, y, rowO);
      for (var x = 0; x < hi.width; x += step)
      {
         var h = rowH[x], o = rowO[x];
         if (h + o > 1.0e-4) { lum.push(Math.max(h, o)); rat.push(o / (h + o)); }
      }
   }
   if (rat.length < 100)
      return 0.4;
   var sortedLum = lum.slice(0).sort(function (a, b) { return a - b; });
   var cut = sortedLum[sortedLum.length >> 1];
   var sel = [];
   for (var i = 0; i < rat.length; ++i)
      if (lum[i] >= cut) sel.push(rat[i]);
   sel.sort(function (a, b) { return a - b; });
   return sel.length > 0 ? sel[sel.length >> 1] : 0.4;
}

/*
 * Green reduction (SCNR-style, average neutral): green above the average of
 * red and blue is removed, by the given percentage. Raw SHO is green-dominated
 * because Ha, usually the strongest line, goes to green.
 */
function applyGreenReduction(e, percent)
{
   var a = Math.max(0, Math.min(100, percent)) / 100;
   if (a <= 0)
      return e;
   var excess = "max(" + e.G + " - (" + e.R + " + " + e.B + ") / 2, 0)";
   return { R: e.R, G: "(" + e.G + " - " + fmt(a) + " * " + excess + ")", B: e.B };
}

/*
 * A warning when the blend cannot work as intended with the selected images,
 * or "" when all is well.
 */
function blendWarning(settings)
{
   if (isValidView(settings.sii))
      return "";
   if (settings.blendMode == BLEND_PALETTE)
   {
      var w = settings.paletteWeights;
      var channels = [];
      if (w[0][2]) channels.push("red");
      if (w[1][2]) channels.push("green");
      if (w[2][2]) channels.push("blue");
      if (channels.length > 0)
      {
         var empty = [];
         for (var c = 0; c < 3; ++c)
            if (w[c][2] && !w[c][0] && !w[c][1])
               empty.push(["red", "green", "blue"][c]);
         return "No SII image selected: this palette's SII terms are zero" +
                (empty.length > 0 ? " (" + empty.join(" and ") + " channel empty)" : "") +
                ". Select SII, or use HOO.";
      }
   }
   if (settings.blendMode == BLEND_CUSTOM)
   {
      var expr = settings.customR + " " + settings.customG + " " + settings.customB;
      if (/\bS\b/.test(expr))
         return "No SII image selected, but the custom expressions use S.";
   }
   return "";
}

// Luminance-preserving saturation applied to the three channel expressions
function applySaturation(e, k)
{
   if (Math.abs(k - 1) < 1.0e-6)
      return e;
   var Y = "(0.2126 * " + e.R + " + 0.7152 * " + e.G + " + 0.0722 * " + e.B + ")";
   function sat(c) { return "(" + Y + " + " + fmt(k) + " * (" + c + " - " + Y + "))"; }
   return { R: sat(e.R), G: sat(e.G), B: sat(e.B) };
}

function pixelMathRGB(referenceView, e, newId, hidden)
{
   var P = new PixelMath;
   P.expression = e.R;
   P.expression1 = e.G;
   P.expression2 = e.B;
   P.useSingleExpression = false;
   P.symbols = "";
   P.generateOutput = true;
   P.singleThreaded = false;
   P.optimization = true;
   P.use64BitWorkingImage = false;
   P.rescale = false;
   P.truncate = true;
   P.truncateLower = 0;
   P.truncateUpper = 1;
   P.createNewImage = true;
   P.showNewImage = !hidden;
   P.newImageId = newId;
   P.newImageWidth = 0;
   P.newImageHeight = 0;
   P.newImageAlpha = false;
   P.newImageColorSpace = PixelMath.prototype.RGB;
   P.newImageSampleFormat = PixelMath.prototype.f32;
   P.executeOn(referenceView, false);
   return View.viewById(newId);
}

function blendExpressions(settings, ids, refViews, quiet, fixedCenter)
{
   var H = ids[L_HA], O = ids[L_OIII], S = ids[L_SII] || null;
   var e;
   switch (settings.blendMode)
   {
   case BLEND_RATIO:
      var center = (fixedCenter != null && fixedCenter !== undefined) ? fixedCenter :
                   (settings.ratioAutoCenter ? typicalRatio(refViews[L_HA], refViews[L_OIII]) : settings.ratioCenter);
      if (!quiet)
         Console.writeln(format("  ratio color: center %.3f%s, balance %d, contrast %.1f",
                                center, settings.ratioAutoCenter ? " (auto)" : "", Math.round(settings.ratioBalance), settings.ratioContrast));
      settings.lastRatioCenter = center;
      var c = settings.smoothIds || [];
      e = ratioExpressions(H, O, S, settings, center, c[L_HA], c[L_OIII], c[L_SII]);
      break;
   case BLEND_PALETTE:
      e = paletteExpressions(H, O, S, settings.paletteWeights);
      var warning = blendWarning(settings);
      if (warning && !quiet) Console.warningln("  " + warning);
      break;
   case BLEND_CUSTOM:
      e = { R: "(" + substituteSymbols(settings.customR, H, O, S) + ")",
            G: "(" + substituteSymbols(settings.customG, H, O, S) + ")",
            B: "(" + substituteSymbols(settings.customB, H, O, S) + ")" };
      break;
   case BLEND_FORAXX:
   default:
      e = foraxxExpressions(H, O, S);
      break;
   }
   return applySaturation(applyGreenReduction(e, settings.greenReduction || 0), settings.saturation);
}

/*
 * Foraxx finishing: the hue and saturation adjustments the ForaxxPalette
 * utility applies after its blend. These settings (curve points) are from
 * Paul Hancock's ForaxxPalette (2023); they are applied here with PixInsight's
 * own CurvesTransformation and ColorSaturation processes.
 *
 *  1. Hue curve pushing reds toward orange-gold and blues toward deeper blue,
 *     plus a saturation curve lifting mid-saturation colors.
 *  2. A second, smaller hue shift.
 *  3. Saturation boosted around gold/orange and blue only, applied twice.
 */
var FORAXX_HUE_1 = [[0.00000, 0.00000], [0.02517, 0.05952], [0.07323, 0.08571], [0.11442, 0.13810], [0.62014, 0.67619], [1.00000, 1.00000]];
var FORAXX_SAT_1 = [[0.00000, 0.00000], [0.50801, 0.61667], [1.00000, 1.00000]];
var FORAXX_HUE_2 = [[0.00000, 0.00000], [0.05034, 0.03571], [0.08238, 0.10238], [0.24943, 0.25000], [1.00000, 1.00000]];
var FORAXX_HUE_SAT = [[0.00000, 0.00000], [0.04910, 0.00909], [0.07235, 0.00909], [0.10594, 0.15455], [0.19380, 0.00909],
                      [0.37726, 0.00000], [0.52972, 0.00909], [0.60465, 0.13636], [0.68475, -0.00909], [0.84496, 0.00000],
                      [1.00000, 0.00000]];

function applyForaxxFinishing(view)
{
   var C1 = new CurvesTransformation;
   C1.H = FORAXX_HUE_1;
   C1.Ht = CurvesTransformation.prototype.AkimaSubsplines;
   C1.S = FORAXX_SAT_1;
   C1.St = CurvesTransformation.prototype.AkimaSubsplines;
   C1.executeOn(view, false);

   var C2 = new CurvesTransformation;
   C2.H = FORAXX_HUE_2;
   C2.Ht = CurvesTransformation.prototype.AkimaSubsplines;
   C2.executeOn(view, false);

   for (var i = 0; i < 2; ++i)
   {
      var CS = new ColorSaturation;
      CS.HS = FORAXX_HUE_SAT;
      CS.HSt = ColorSaturation.prototype.AkimaSubsplines;
      CS.hueShift = 0.000;
      CS.executeOn(view, false);
   }
}

function closeSmoothed(settings)
{
   var list = settings.smoothIds || [];
   for (var i = 0; i < list.length; ++i)
      if (list[i])
      {
         var w = ImageWindow.windowById(list[i]);
         if (isValidWindow(w)) w.forceClose();
      }
   settings.smoothIds = [];
}

/*
 * opts (optional):
 *    hidden:      create a hidden temporary image (preview)
 *    quiet:       no console report
 *    smoothScale: divide the color smoothing radius by this (downsampled preview)
 *    center:      ratio color center to use instead of measuring it (zoomed preview crop)
 */
function blendLines(settings, stretched, opts)
{
   opts = opts || {};
   var ids = [], views = [];
   for (var i = 0; i < stretched.length; ++i)
   {
      ids[stretched[i].line] = stretched[i].id;
      views[stretched[i].line] = View.viewById(stretched[i].id);
   }
   var mode = (settings.blendMode >= 0 && settings.blendMode < BLEND_NAMES.length) ? settings.blendMode : 0;
   var palette = mode == BLEND_FORAXX ? (ids[L_SII] ? "SHO" : "HOO") : "";
   if (!opts.quiet)
      Console.noteln("Blending: ", BLEND_NAMES[mode], palette ? " " + palette : "");
   // Color smoothing (ratio mode): color from blurred copies, brightness stays sharp
   settings.smoothIds = [];
   if (mode == BLEND_RATIO && settings.colorSmoothing > 0)
   {
      var radius = Math.max(0.3, settings.colorSmoothing / (opts.smoothScale || 1));
      if (!opts.quiet)
         Console.writeln(format("  color smoothing: %.1f px", settings.colorSmoothing));
      for (var li in ids)
      {
         if (!ids[li]) continue;
         var sid = uniqueId("nb_smooth_" + LINE_NAMES[li]);
         var sv = pixelMathNew(views[li], ids[li], sid, true);
         var C = new Convolution;
         C.mode = Convolution.prototype.Parametric;
         C.sigma = radius;
         C.shape = 2;
         C.aspectRatio = 1;
         C.rotationAngle = 0;
         C.executeOn(sv, false);
         settings.smoothIds[li] = sid;
      }
   }
   var e;
   try
   {
      e = blendExpressions(settings, ids, views, opts.quiet, opts.center);
   }
   catch (err)
   {
      closeSmoothed(settings);
      throw err;
   }
   var tag = ["Foraxx", "Ratio", "Palette", "Custom"][mode];
   var id = uniqueId(opts.hidden ? "nbp_rgb" : "NB_" + tag);
   var out;
   try
   {
      out = pixelMathRGB(views[L_HA], e, id, opts.hidden);
   }
   finally
   {
      closeSmoothed(settings);   // also when PixelMath rejects a custom expression
   }
   if (!isValidView(out))
      throw new Error("Could not create the color image " + id + ".");
   if (!opts.hidden)
      copyAstrometricSolution(isValidView(settings.ha) ? settings.ha : null, id);
   if (settings.foraxxFinishing)
   {
      if (!opts.quiet)
         Console.writeln("  applying Foraxx finishing (hue and saturation curves)");
      applyForaxxFinishing(out);
   }
   if (!opts.hidden)
      Console.writeln("  created ", id);
   return id;
}

/*
 * PREVIEW ENGINE
 *
 * The preview goes through exactly the same stretch and blend as Apply, using
 * black points and gains measured on the full-resolution inputs. All
 * intermediate images are hidden and removed again.
 *
 *  - Fit: copies of the inputs reduced to the preview area's real (physical)
 *    pixel size, so the preview stays sharp on large and HiDPI screens.
 *  - 100% (1:1): a crop of the full-resolution inputs the size of the
 *    preview area, around a chosen point.
 */
#define PREVIEW_SIZE 640       // minimum preview panel size (logical pixels)
#define OVERVIEW_SIZE 800

// Preview quality: fraction of the screen resolution that is computed
var PREVIEW_QUALITY = [1.0, 0.7, 0.5];
var PREVIEW_QUALITY_NAMES = ["Sharp", "Balanced", "Fast"];

#define SHOW_BLEND 0
#define SHOW_HA 1
#define SHOW_OIII 2
#define SHOW_SII 3
var SHOW_NAMES = ["Blend", "Ha (stretched)", "OIII (stretched)", "SII (stretched)"];

function closeById(id)
{
   var w = ImageWindow.windowById(id);
   if (isValidWindow(w)) w.forceClose();
}

function inputsKey(lines)
{
   var key = "";
   for (var i = 0; i < lines.length; ++i)
      key += lines[i].line + ":" + lines[i].view.id + ":" + lines[i].view.image.width + "x" + lines[i].view.image.height + ";";
   return key;
}

// Hidden copies of the lines reduced by an integer factor: { line: view }, plus their ids
function reducedCopies(lines, factor, tag)
{
   var out = { views: {}, ids: [] };
   for (var i = 0; i < lines.length; ++i)
   {
      var id = uniqueId("nbp_" + tag + "_" + LINE_NAMES[lines[i].line]);
      var v = pixelMathNew(lines[i].view, lines[i].view.id, id, true);
      if (factor > 1)
      {
         var R = new IntegerResample;
         R.zoomFactor = -factor;
         R.downsamplingMode = IntegerResample.prototype.Average;
         R.executeOn(v, false);
      }
      out.views[lines[i].line] = v;
      out.ids.push(id);
   }
   return out;
}

// Hidden full-resolution crops of the lines: { line: view }, plus their ids
function cropCopies(lines, rect)
{
   var out = { views: {}, ids: [] };
   var w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
   var buf = new Float32Array(w * h);
   for (var i = 0; i < lines.length; ++i)
   {
      var id = uniqueId("nbp_crop_" + LINE_NAMES[lines[i].line]);
      var win = new ImageWindow(w, h, 1, 32, true, false, id);
      var v = win.mainView;
      lines[i].view.image.getSamples(buf, rect, 0);
      v.beginProcess(UndoFlag_NoSwapFile);
      v.image.setSamples(buf, new Rect(0, 0, w, h), 0);
      v.endProcess();
      out.views[lines[i].line] = v;
      out.ids.push(win.mainView.id);
   }
   return out;
}

function PreviewEngine()
{
   this.fit = null;         // { views, ids, factor, key }
   this.overview = null;    // small copies for the ratio color center
   this.centerCache = { key: "", value: 0.4 };
   this.factor = 1;

   this.closeSet = function (set)
   {
      if (set == null) return;
      for (var i = 0; i < set.ids.length; ++i)
         closeById(set.ids[i]);
   };

   this.close = function ()
   {
      this.closeSet(this.fit);
      this.closeSet(this.overview);
      this.fit = null;
      this.overview = null;
      this.centerCache = { key: "", value: 0.4 };
   };

   // Fit sources for a preview area of targetW x targetH physical pixels
   this.fitSources = function (lines, targetW, targetH)
   {
      var img = lines[0].view.image;
      // Factor rounded down: computed at or above screen resolution, then scaled down smoothly when drawn
      var factor = Math.max(1, Math.floor(Math.max(img.width / targetW, img.height / targetH)));
      var key = inputsKey(lines) + "f" + factor;
      if (this.fit == null || this.fit.key != key)
      {
         this.closeSet(this.fit);
         this.fit = reducedCopies(lines, factor, "fit");
         this.fit.key = key;
         this.fit.factor = factor;
      }
      this.factor = factor;
      return this.fit.views;
   };

   // Ratio color center of the whole image, from a small overview (cached per stretch settings)
   this.ratioCenter = function (settings, lines)
   {
      var img = lines[0].view.image;
      var factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / OVERVIEW_SIZE));
      var okey = inputsKey(lines) + "o" + factor;
      if (this.overview == null || this.overview.key != okey)
      {
         this.closeSet(this.overview);
         this.overview = reducedCopies(lines, factor, "ovw");
         this.overview.key = okey;
         this.centerCache.key = "";
      }
      var skey = okey + [settings.shadowClip, settings.targetMedian, settings.link, settings.contrast,
                         settings.highlightProtection, settings.neutralBackground].join(",");
      if (this.centerCache.key != skey)
      {
         var st = stretchLines(settings, { sources: this.overview.views, hidden: true, quiet: true });
         var v = {};
         for (var i = 0; i < st.length; ++i) v[st[i].line] = View.viewById(st[i].id);
         this.centerCache.value = typicalRatio(v[L_HA], v[L_OIII]);
         this.centerCache.key = skey;
         for (i = 0; i < st.length; ++i) closeById(st[i].id);
      }
      return this.centerCache.value;
   };

   /*
    * Runs stretch (+ blend) for the preview. Returns { id, temp: [ids to close
    * afterwards], info } for the image to display.
    *   targetW, targetH: preview area in physical pixels
    *   zoom: 0 = fit, 1 = 100% crop around center ({ x, y } in image pixels)
    */
   this.compute = function (settings, show, targetW, targetH, zoom, center)
   {
      var lines = inputLines(settings);
      var img = lines[0].view.image;
      targetW = Math.max(64, Math.round(targetW || 640));
      targetH = Math.max(64, Math.round(targetH || 460));
      var sources, info, temp = [], fixedCenter = null, scale = 1;
      if (zoom == 1)
      {
         var cx = center ? center.x : img.width / 2, cy = center ? center.y : img.height / 2;
         var cw = Math.min(img.width, targetW), ch = Math.min(img.height, targetH);
         var x0 = Math.round(Math.min(Math.max(cx - cw / 2, 0), img.width - cw));
         var y0 = Math.round(Math.min(Math.max(cy - ch / 2, 0), img.height - ch));
         var crop = cropCopies(lines, new Rect(x0, y0, x0 + cw, y0 + ch));
         sources = crop.views;
         temp = temp.concat(crop.ids);
         info = { zoom: 1, x0: x0, y0: y0, w: cw, h: ch, center: { x: x0 + cw / 2, y: y0 + ch / 2 } };
         if (show == SHOW_BLEND && settings.blendMode == BLEND_RATIO)
            fixedCenter = this.ratioCenter(settings, lines);
      }
      else
      {
         sources = this.fitSources(lines, targetW, targetH);
         scale = this.factor;
         info = { zoom: 0, factor: this.factor };
      }
      var stretched, i;
      try
      {
         stretched = stretchLines(settings, { sources: sources, hidden: true, quiet: true });
         for (i = 0; i < stretched.length; ++i) temp.push(stretched[i].id);
         if (show == SHOW_BLEND)
         {
            var rgb = blendLines(settings, stretched, { hidden: true, quiet: true, smoothScale: scale, center: fixedCenter });
            temp.push(rgb);
            return { id: rgb, temp: temp, info: info };
         }
      }
      catch (err)
      {
         // Remove whatever this preview created before reporting the error
         for (i = 0; i < temp.length; ++i) closeById(temp[i]);
         throw err;
      }
      var want = show == SHOW_HA ? L_HA : (show == SHOW_OIII ? L_OIII : L_SII);
      for (i = 0; i < stretched.length; ++i)
         if (stretched[i].line == want)
            return { id: stretched[i].id, temp: temp, info: info };
      for (i = 0; i < temp.length; ++i) closeById(temp[i]);
      throw new Error("No " + LINE_NAMES[want] + " image selected.");
   };
}

// Bitmap of an image (RGB or mono) for display
function imageToBitmap(view)
{
   var img = view.image;
   try
   {
      var b = img.render();
      if (b && b.width > 0)
         return b;
   }
   catch (e)
   {
   }
   // Fallback: build the bitmap pixel by pixel
   var bmp = new Bitmap(img.width, img.height);
   var nc = img.numberOfChannels;
   var rows = [new Float32Array(img.width), new Float32Array(img.width), new Float32Array(img.width)];
   for (var y = 0; y < img.height; ++y)
   {
      for (var c = 0; c < Math.min(3, nc); ++c)
      {
         try { img.getSamples(rows[c], new Rect(0, y, img.width, y + 1), c); }
         catch (e2) { for (var xx = 0; xx < img.width; ++xx) rows[c][xx] = img.sample(xx, y, c); }
      }
      for (var x = 0; x < img.width; ++x)
      {
         var r = Math.round(255 * Math.min(1, Math.max(0, rows[0][x])));
         var g = nc >= 3 ? Math.round(255 * Math.min(1, Math.max(0, rows[1][x]))) : r;
         var bl = nc >= 3 ? Math.round(255 * Math.min(1, Math.max(0, rows[2][x]))) : r;
         bmp.setPixel(x, y, (0xff000000 | (r << 16) | (g << 8) | bl) >>> 0);
      }
   }
   return bmp;
}

function NarrowbandStart(settings)
{
   Console.show();
   var created = [], i;
   try
   {
      // Stretched lines are only shown when they are kept; otherwise they stay hidden
      var res = stretchLines(settings, { hidden: !settings.keepMono });
      for (i = 0; i < res.length; ++i) created.push(res[i].id);
      var rgb = blendLines(settings, res);
      if (!settings.keepMono)
      {
         for (i = 0; i < res.length; ++i)
            closeById(res[i].id);
         created = [];
      }
      created.push(rgb);
      Console.noteln(TITLE, " finished: ", created.join(", "));
      return created;
   }
   catch (e)
   {
      // Do not leave stretched lines behind that the user did not ask to keep
      if (!settings.keepMono)
         for (i = 0; i < created.length; ++i)
            closeById(created[i]);
      Console.criticalln(TITLE, " error: ", e.message);
      (new MessageBox(TITLE + " failed:<br/>" + e.message, TITLE, StdIcon_Error, StdButton_Ok)).execute();
      return [];
   }
}


/*
 * PARAMETERS
 */
/*
 * Sensible starting values when the blend mode changes:
 *  Foraxx and classic palettes are designed around equally stretched lines
 *  (link 0%); ratio color measures the line ratio itself, so linking mostly
 *  decides how much faint-line noise is lifted (75%).
 *  Foraxx finishing is on for Foraxx, off otherwise.
 */
function applyModeDefaults(settings)
{
   switch (settings.blendMode)
   {
   case BLEND_FORAXX:  settings.link = 0;  settings.foraxxFinishing = true;  break;
   case BLEND_RATIO:   settings.link = 75; settings.foraxxFinishing = false; break;
   case BLEND_PALETTE: settings.link = 0;  settings.foraxxFinishing = false; break;
   default: break;     // custom: leave as is
   }
}

/*
 * Reset sliders: every slider back to its default for the current blend mode.
 * Keeps the input images, the mode, the color preset, the selected palette
 * (its weights are reset to that palette) and custom expressions.
 */
function resetSliders(settings)
{
   var d = new parametersPrototype();
   d.setDefaults();
   var keys = ["shadowClip", "targetMedian", "contrast", "highlightProtection", "neutralBackground", "ratioBalance", "ratioContrast",
               "siiStrength", "ratioBrightness", "colorSmoothing", "saturation", "greenReduction"];
   for (var i = 0; i < keys.length; ++i)
      settings[keys[i]] = d[keys[i]];
   var pi = (settings.paletteIndex >= 0 && settings.paletteIndex < PALETTES.length) ? settings.paletteIndex : 0;
   settings.paletteWeights = copyWeights(PALETTES[pi].w);
   applyModeDefaults(settings);   // link and Foraxx finishing for this mode
}

function copyWeights(w)
{
   return [w[0].slice(0), w[1].slice(0), w[2].slice(0)];
}

function parametersPrototype()
{
   this.setDefaults = function ()
   {
      this.ha = null;
      this.oiii = null;
      this.sii = null;
      this.shadowClip = 3.0;
      this.targetMedian = 0.25;
      this.link = 0;     // Foraxx (the default blend) expects equal medians
      this.neutralBackground = true;
      this.contrast = 40;
      this.highlightProtection = 0;
      this.blendMode = BLEND_FORAXX;
      this.ratioPreset = 0;
      this.ratioBalance = 0;
      this.ratioContrast = 3.0;
      this.ratioAutoCenter = true;
      this.ratioCenter = 0.4;
      this.lastRatioCenter = 0.4;
      this.siiStrength = 1.0;
      this.paletteIndex = 0;
      this.paletteWeights = copyWeights(PALETTES[0].w);
      this.customR = "H";
      this.customG = "0.5*H + 0.5*O";
      this.customB = "O";
      this.saturation = 1.0;
      this.greenReduction = 0;
      this.foraxxFinishing = true;
      this.ratioBrightness = 1.4;
      this.colorSmoothing = 2.0;
      this.keepMono = false;
   };

   this.setParameters = function ()
   {
      Parameters.clear();
      if (isValidView(this.ha)) Parameters.set("ha", this.ha.id);
      if (isValidView(this.oiii)) Parameters.set("oiii", this.oiii.id);
      if (isValidView(this.sii)) Parameters.set("sii", this.sii.id);
      Parameters.set("shadowClip", this.shadowClip);
      Parameters.set("targetMedian", this.targetMedian);
      Parameters.set("link", this.link);
      Parameters.set("neutralBackground", this.neutralBackground);
      Parameters.set("contrast", this.contrast);
      Parameters.set("highlightProtection", this.highlightProtection);
      Parameters.set("blendMode", this.blendMode);
      Parameters.set("ratioPreset", this.ratioPreset);
      Parameters.set("ratioBalance", this.ratioBalance);
      Parameters.set("ratioContrast", this.ratioContrast);
      Parameters.set("ratioAutoCenter", this.ratioAutoCenter);
      Parameters.set("ratioCenter", this.ratioCenter);
      Parameters.set("siiStrength", this.siiStrength);
      Parameters.set("paletteIndex", this.paletteIndex);
      for (var c = 0; c < 3; ++c)
         for (var k = 0; k < 3; ++k)
            Parameters.set("w" + c + k, this.paletteWeights[c][k]);
      Parameters.set("customR", this.customR);
      Parameters.set("customG", this.customG);
      Parameters.set("customB", this.customB);
      Parameters.set("saturation", this.saturation);
      Parameters.set("greenReduction", this.greenReduction);
      Parameters.set("foraxxFinishing", this.foraxxFinishing);
      Parameters.set("ratioBrightness", this.ratioBrightness);
      Parameters.set("colorSmoothing", this.colorSmoothing);
      Parameters.set("keepMono", this.keepMono);
   };

   this.getParameters = function ()
   {
      if (Parameters.has("ha")) this.ha = View.viewById(Parameters.getString("ha"));
      if (Parameters.has("oiii")) this.oiii = View.viewById(Parameters.getString("oiii"));
      if (Parameters.has("sii")) this.sii = View.viewById(Parameters.getString("sii"));
      if (Parameters.has("shadowClip")) this.shadowClip = Parameters.getReal("shadowClip");
      if (Parameters.has("targetMedian")) this.targetMedian = Parameters.getReal("targetMedian");
      if (Parameters.has("link")) this.link = Parameters.getReal("link");
      if (Parameters.has("neutralBackground")) this.neutralBackground = Parameters.getBoolean("neutralBackground");
      if (Parameters.has("contrast")) this.contrast = Parameters.getReal("contrast");
      if (Parameters.has("highlightProtection")) this.highlightProtection = Parameters.getReal("highlightProtection");
      if (Parameters.has("blendMode")) this.blendMode = Parameters.getInteger("blendMode");
      if (Parameters.has("ratioPreset")) this.ratioPreset = Parameters.getInteger("ratioPreset");
      if (Parameters.has("ratioBalance")) this.ratioBalance = Parameters.getReal("ratioBalance");
      if (Parameters.has("ratioContrast")) this.ratioContrast = Parameters.getReal("ratioContrast");
      if (Parameters.has("ratioAutoCenter")) this.ratioAutoCenter = Parameters.getBoolean("ratioAutoCenter");
      if (Parameters.has("ratioCenter")) this.ratioCenter = Parameters.getReal("ratioCenter");
      if (Parameters.has("siiStrength")) this.siiStrength = Parameters.getReal("siiStrength");
      if (Parameters.has("paletteIndex")) this.paletteIndex = Parameters.getInteger("paletteIndex");
      for (var c = 0; c < 3; ++c)
         for (var k = 0; k < 3; ++k)
            if (Parameters.has("w" + c + k)) this.paletteWeights[c][k] = Parameters.getReal("w" + c + k);
      if (Parameters.has("customR")) this.customR = Parameters.getString("customR");
      if (Parameters.has("customG")) this.customG = Parameters.getString("customG");
      if (Parameters.has("customB")) this.customB = Parameters.getString("customB");
      if (Parameters.has("saturation")) this.saturation = Parameters.getReal("saturation");
      if (Parameters.has("greenReduction")) this.greenReduction = Parameters.getReal("greenReduction");
      if (Parameters.has("foraxxFinishing")) this.foraxxFinishing = Parameters.getBoolean("foraxxFinishing");
      if (Parameters.has("ratioBrightness")) this.ratioBrightness = Parameters.getReal("ratioBrightness");
      if (Parameters.has("colorSmoothing")) this.colorSmoothing = Parameters.getReal("colorSmoothing");
      else if (Parameters.has("colourSmoothing")) this.colorSmoothing = Parameters.getReal("colourSmoothing");   // 1.0 icons
      if (Parameters.has("keepMono")) this.keepMono = Parameters.getBoolean("keepMono");
   };

   this.autoPick = function ()
   {
      if (!isValidView(this.ha)) this.ha = autoPickView(LINE_INPUT_BASES[L_HA]);
      if (!isValidView(this.oiii)) this.oiii = autoPickView(LINE_INPUT_BASES[L_OIII]);
      if (!isValidView(this.sii)) this.sii = autoPickView(LINE_INPUT_BASES[L_SII]);
   };
}

var data = new parametersPrototype();
data.setDefaults();


/*
 * DIALOG
 */
/*
 * HELP
 */
var GUIDE_HTML =
   "<h2>NarrowbandProcessing " + VERSION + " guide</h2>\n" +
   "<p>NarrowbandProcessing turns <b>linear</b> narrowband line images (Ha, OIII and optionally SII) into a finished-looking color image. It does two jobs in one go: it <b>stretches</b> each line (makes the faint nebula visible) and <b>blends</b> them into color. The preview on the right shows the result at your screen's full resolution; <b>Apply</b> creates the full-size image.</p>\n" +
   "\n" +
   "<h3>Quick start</h3>\n" +
   "<ol>\n" +
   "<li><b>Get your line images.</b><br/>\n" +
   "&bull; <i>One-shot color camera with a dual-band filter</i> (L-eNhance, L-eXtreme, ...): run <b>DBXtract</b> first. It creates <b>_HA</b> and <b>_OIII</b> (and <b>_SII</b> with an SII filter).<br/>\n" +
   "&bull; <i>Mono camera with separate filters</i>: use your stacked Ha, OIII and SII masters directly. Skip DBXtract.<br/>\n" +
   "The images must be <b>linear</b> (not stretched yet) and the same size (registered to each other).</li>\n" +
   "<li><b>Open NarrowbandProcessing.</b> It picks up _HA, _OIII and _SII automatically; otherwise choose them at the top.</li>\n" +
   "<li><b>Choose a Mode</b> in the Blend box. <b>Foraxx</b> is a great starting point. Sensible defaults are set for each mode.</li>\n" +
   "<li><b>Adjust while watching the preview.</b> Usually only Contrast, Highlight protection and Saturation need changing.</li>\n" +
   "<li><b>Click Apply.</b> The result is called <b>NB_Foraxx</b>, <b>NB_Ratio</b>, <b>NB_Palette</b> or <b>NB_Custom</b>.</li>\n" +
   "</ol>\n" +
   "\n" +
   "<h3>Stretch controls</h3>\n" +
   "<p><b>Shadow clip</b> - how dark the background gets. The black point is set from the real sky background, a number of noise levels (sigma) below it. Lower = darker, deeper shadows; higher = softer, more faint detail kept. Default 3.</p>\n" +
   "<p><b>Target median</b> - overall brightness. 0.25 suits most images; lower is darker and moodier.</p>\n" +
   "<p><b>Link lines</b> - how the fainter lines (OIII, SII) are stretched compared with Ha.<br/>\n" +
   "&bull; <b>0%</b>: every line is brightened to the same level. Needed for Foraxx and classic palettes, which expect balanced lines.<br/>\n" +
   "&bull; <b>100%</b>: all lines share one stretch, so faint OIII stays faint. Cleaner shadows, less noise.<br/>\n" +
   "&bull; In between: faint lines catch up partway. Ratio color defaults to 75%.</p>\n" +
   "<p><b>Contrast</b> - darker shadows and dust lanes, more punch in the mid-tones. The background and overall brightness stay put. 30-50 suits most targets.</p>\n" +
   "<p><b>Highlight protection</b> - keeps detail in very bright regions, such as the core of M42, instead of letting them turn white. Leave at 0 for most targets; use 50-80 for bright cores.</p>\n" +
   "<p><b>Neutral background</b> - keeps the empty sky gray rather than tinted. Leave it on.</p>\n" +
   "\n" +
   "<h3>Blend modes</h3>\n" +
   "<p><b>Foraxx (dynamic)</b> - the popular Foraxx palette: gold where Ha dominates, blue where OIII dominates. HOO with Ha and OIII; SHO automatically when SII is selected. Use with Link 0% and Foraxx finishing on.</p>\n" +
   "<p><b>Ratio color</b> - color comes from how much OIII there is compared with Ha, so every area gets a color that reflects its chemistry.<br/>\n" +
   "&bull; <b>Colors</b>: the color pair, e.g. Gold + blue core.<br/>\n" +
   "&bull; <b>Balance</b>: moves the gold/blue split. Negative = more gold, positive = more blue. 0 centers it on your image automatically.<br/>\n" +
   "&bull; <b>Contrast</b> (blend): how sharply gold changes into blue.<br/>\n" +
   "&bull; <b>SII strength</b>: how strongly SII adds red-orange (only with an SII image).<br/>\n" +
   "&bull; <b>Brightness</b>: overall brightness of this mode.<br/>\n" +
   "&bull; <b>Color smoothing</b>: removes color speckle in faint areas without blurring detail. 2 px is a good default; raise it if faint areas look blotchy.</p>\n" +
   "<p><b>Classic palette</b> - fixed mixes like HOO, SHO (Hubble palette) and HSO. The grid shows how much of each line goes into red, green and blue; you can edit it. Raw SHO is naturally very green, so use <b>Green reduction</b>.</p>\n" +
   "<p><b>Custom PixelMath</b> - type your own red, green and blue formulas using <b>H</b>, <b>O</b> and <b>S</b> (the stretched lines). Example: R = H, G = 0.5*H + 0.5*O, B = O.</p>\n" +
   "\n" +
   "<h3>Finishing controls</h3>\n" +
   "<p><b>Saturation</b> - color strength (1 = unchanged). Brightness is not affected.</p>\n" +
   "<p><b>Green reduction</b> - removes excess green, like SCNR. Use 70-100% for SHO.</p>\n" +
   "<p><b>Foraxx finishing</b> - the hue and saturation curves from the ForaxxPalette utility: reds pushed toward gold, blues deepened, gold and blue boosted. Works with any mode.</p>\n" +
   "<p><b>Reset all sliders</b> - puts every Stretch and Blend slider back to its default for the current mode. Your images and mode are kept.</p>\n" +
   "<p><b>Keep stretched mono lines</b> - also keeps the stretched _HA_s, _OIII_s and _SII_s images after Apply, for use in other tools.</p>\n" +
   "\n" +
   "<h3>Preview</h3>\n" +
   "<p>The preview updates shortly after each change and is computed at your screen's full resolution, so it stays sharp on large and high-resolution (Retina / 4K) screens. It is recomputed when you resize the window. <b>Show</b> switches between the blend and each stretched line on its own. Untick <b>Live update</b> to change several settings first, then click <b>Refresh</b>. The first update after opening takes a few seconds while the full images are measured.</p>\n" +
   "<p><b>Zoom</b> - <b>Fit</b> shows the whole image; <b>100% (1:1)</b> shows real pixels, exactly as Apply will produce them. <b>Double-click</b> the preview to zoom to 100% at that point and double-click again to go back to Fit. At 100%, <b>drag</b> to pan.</p>\n" +
   "<p><b>Quality</b> - <b>Sharp</b> (recommended) computes every screen pixel. <b>Balanced</b> (70%) and <b>Fast</b> (50%) compute fewer pixels and enlarge them, so they update faster on slow computers but look softer. Quality only affects the preview, never the result. The status line under the preview shows how long each update took.</p>\n" +
   "\n" +
   "<h3>Recipes</h3>\n" +
   "<p><b>Classic Foraxx look</b> - Mode Foraxx, Link 0%, Contrast 40, Foraxx finishing on.</p>\n" +
   "<p><b>Gold + blue</b> - Mode Ratio color, Colors Gold + blue core, Link 75%, Contrast 30-40, Color smoothing 2, Saturation 1.2-1.4.</p>\n" +
   "<p><b>Hubble palette (SHO)</b> - needs an SII image. Mode Classic palette, Palette SHO, Link 0%, Green reduction 80-100%, Saturation about 1.3. Or simply use Foraxx with SII selected.</p>\n" +
   "<p><b>Very bright core (M42)</b> - any mode, Highlight protection 50-80. Afterwards, HDRMultiscaleTransform on the color image can add extra core contrast.</p>\n" +
   "\n" +
   "<h3>Troubleshooting</h3>\n" +
   "<p><b>Everything is green or cyan</b> - a palette that uses SII is selected but no SII image is (the preview shows a warning). Select SII or use HOO. With real SII, raw SHO is green by nature: use Green reduction.</p>\n" +
   "<p><b>Foraxx shows little or no blue</b> - set Link lines to 0%.</p>\n" +
   "<p><b>Shadows or dust lanes look blue</b> - raise Link lines, so OIII's background noise is not brightened as much.</p>\n" +
   "<p><b>Background has a color cast</b> - make sure Neutral background is ticked.</p>\n" +
   "<p><b>Faint areas full of colored speckle</b> (Ratio color) - raise Color smoothing.</p>\n" +
   "<p><b>Image looks flat or gray</b> - raise Contrast, and for Foraxx make sure Foraxx finishing is on.</p>\n" +
   "<p><b>Bright core is pure white</b> - raise Highlight protection. If it stays white, the core may be saturated in the data itself; only shorter exposures can recover it.</p>\n" +
   "<p><b>Colors change a lot after gradient removal</b> - on nebulae that fill the whole frame, automatic gradient tools can remove real nebulosity (often the blue OIII haze). Skip gradient removal or use DBE with samples only in the darkest areas.</p>\n" +
   "<p><b>Nothing appears after Apply</b> - in full-screen mode new windows can be hidden behind the workspace; leave full screen or look in the window list.</p>\n" +
   "\n" +
   "<p><br/>NarrowbandProcessing " + VERSION + " by Justin Pickens, GPL v3. Foraxx finishing curve settings from Paul Hancock's ForaxxPalette utility.</p>\n";

function HelpDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   this.text = new TextBox(this);
   this.text.readOnly = true;
   this.text.text = GUIDE_HTML;
   try { this.text.caretPosition = 0; } catch (e) { }
   this.text.setScaledMinSize(720, 620);

   this.close_Button = new PushButton(this);
   this.close_Button.text = "Close";
   this.close_Button.onClick = function () { this.dialog.ok(); };

   var buttons = new HorizontalSizer;
   buttons.addStretch();
   buttons.add(this.close_Button);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add(this.text, 100);
   this.sizer.add(buttons);

   this.windowTitle = TITLE + " " + VERSION + " - Guide";
   this.adjustToContents();

   // Open at the top of the guide (setting the text leaves the view at the end)
   var self = this;
   this.scrollToTop = function ()
   {
      try { self.text.caretPosition = 0; } catch (e) { }
      try { self.text.home(); } catch (e) { }
      try { self.text.verticalScrollPosition = 0; } catch (e) { }
   };
   this.onShow = function () { self.scrollToTop(); };
}
HelpDialog.prototype = new Dialog;

function NarrowbandDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   var dlg = this;
   var labelWidth = this.font.width("Highlight protection:  ");

   this.headerLabel = new Label(this);
   this.headerLabel.backgroundColor = 0xff2d3a4a;
   this.headerLabel.textColor = 0xffffffff;
   this.headerLabel.useRichText = true;
   this.headerLabel.textAlignment = TextAlign_Center | TextAlign_VertCenter;
   this.headerLabel.margin = 4;
   this.headerLabel.text = "<p><b>" + TITLE + " - Version " + VERSION + "</b></p>";

   this.helpLabel = new Label(this);
   this.helpLabel.frameStyle = FrameStyle_Box;
   this.helpLabel.margin = 4;
   this.helpLabel.wordWrapping = true;
   this.helpLabel.useRichText = true;
   this.helpLabel.text =
      "Stretches linear Ha, OIII and (optionally) SII images with a black point set from the real sky, then blends " +
      "them into a color image. <b>Link lines</b> controls how much fainter lines keep their true brightness " +
      "relative to Ha. The preview uses the same settings (double-click it to zoom to 100%); <b>Apply</b> creates the full-size result.<br><br>" +
      "Justin Pickens - GPL v3";

   function makeLabel(text, parent)
   {
      var l = new Label(parent ? parent : dlg);
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      l.minWidth = labelWidth;
      return l;
   }

   function makeViewList(current, tip, onSelect)
   {
      var vl = new ViewList(dlg);
      vl.getMainViews();
      vl.minWidth = 300;
      vl.toolTip = tip;
      if (isValidView(current))
         vl.currentView = current;
      vl.onViewSelected = function (v) { onSelect(v); dlg.schedulePreview(); };
      return vl;
   }

   function row(controls, stretchLast)
   {
      var s = new HorizontalSizer;
      s.spacing = 4;
      for (var i = 0; i < controls.length; ++i)
         s.add(controls[i], (i == controls.length - 1 && stretchLast) ? 100 : 0);
      if (!stretchLast) s.addStretch();
      return s;
   }

   // Inputs
   this.ha_List = makeViewList(data.ha, "<p>Linear Ha image (mono). Required.</p>",
      function (v) { data.ha = isValidView(v) ? v : null; });
   this.oiii_List = makeViewList(data.oiii, "<p>Linear OIII image (mono). Required.</p>",
      function (v) { data.oiii = isValidView(v) ? v : null; });
   this.sii_List = makeViewList(data.sii, "<p>Linear SII image (mono). Optional.</p>",
      function (v) { data.sii = isValidView(v) ? v : null; });

   this.input_GroupBox = new GroupBox(this);
   this.input_GroupBox.title = "Linear line images";
   this.input_GroupBox.sizer = new VerticalSizer;
   this.input_GroupBox.sizer.margin = 6;
   this.input_GroupBox.sizer.spacing = 6;
   this.input_GroupBox.sizer.add(row([makeLabel("Ha:"), this.ha_List], true));
   this.input_GroupBox.sizer.add(row([makeLabel("OIII:"), this.oiii_List], true));
   this.input_GroupBox.sizer.add(row([makeLabel("SII:"), this.sii_List], true));

   // Stretch
   function numeric(label, lo, hi, precision, steps, value, tip, onChange, parent)
   {
      var c = new NumericControl(parent ? parent : dlg);
      c.label.text = label;
      c.label.minWidth = labelWidth;
      c.setRange(lo, hi);
      c.slider.setRange(0, steps);
      c.setPrecision(precision);
      c.setValue(value);
      c.toolTip = tip;
      c.onValueUpdated = function (v) { onChange(v); dlg.schedulePreview(); };
      return c;
   }

   this.clip_Control = numeric("Shadow clip:", 0.0, 8.0, 1, 160, data.shadowClip,
      "<p>Black point, in multiples of each line's background noise below its measured sky level. " +
      "Higher values keep more of the dark noise above black (softer shadows); lower values give deeper shadows. " +
      "The same setting applies to every line, so the shadows stay neutral.</p>",
      function (v) { data.shadowClip = v; });

   this.target_Control = numeric("Target median:", 0.05, 0.50, 3, 450, data.targetMedian,
      "<p>Brightness that Ha's median (above its black point) is stretched to. 0.25 is a typical value.</p>",
      function (v) { data.targetMedian = v; });

   this.link_Control = numeric("Link lines (%):", 0, 100, 0, 100, data.link,
      "<p><b>100%</b> - one stretch for all lines, set by Ha: OIII and SII keep their true brightness relative to Ha. " +
      "Faint OIII stays faint, and its background noise is not lifted.</p>" +
      "<p><b>0%</b> - every line is stretched to the same median, like Statistical Stretch. Faint lines are boosted, " +
      "along with their noise (the cause of blue shadows in HOO).</p>" +
      "<p>In between, fainter lines catch up partway.</p>",
      function (v) { data.link = v; });

   var ends = new Label(this);
   ends.text = "0% = independent (equal medians)     100% = linked (true relative brightness)";
   ends.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.stretch_GroupBox = new GroupBox(this);
   this.stretch_GroupBox.title = "Stretch";
   this.stretch_GroupBox.sizer = new VerticalSizer;
   this.stretch_GroupBox.sizer.margin = 6;
   this.stretch_GroupBox.sizer.spacing = 6;
   this.stretch_GroupBox.sizer.add(this.clip_Control);
   this.stretch_GroupBox.sizer.add(this.target_Control);
   this.stretch_GroupBox.sizer.add(this.link_Control);
   this.stretch_GroupBox.sizer.add(row([makeLabel(""), ends], false));

   this.contrast_Control2 = numeric("Contrast:", 0, 100, 0, 100, data.contrast,
      "<p>S-curve applied identically to every line after the stretch, pivoting on the target median: " +
      "shadows and dust lanes get darker and mid-tones spread out, while the median and the background level " +
      "stay put. More contrast in each line also gives the blend more color to work with. 0 = off.</p>",
      function (v) { data.contrast = v; });
   this.stretch_GroupBox.sizer.add(this.contrast_Control2);

   this.highlight_Control = numeric("Highlight protection:", 0, 100, 0, 100, data.highlightProtection,
      "<p>Keeps detail in bright regions (for example the core of M42) by blending in a logarithmic stretch, " +
      "which compresses highlights instead of pushing them to white. The median, and so the faint nebulosity, " +
      "stays about the same. Applied identically to every line. 0 = off; 50-80 for targets with very bright cores.</p>",
      function (v) { data.highlightProtection = v; });
   this.stretch_GroupBox.sizer.add(this.highlight_Control);

   this.neutral_CheckBox = new CheckBox(this);
   this.neutral_CheckBox.text = "Neutral background";
   this.neutral_CheckBox.checked = data.neutralBackground;
   this.neutral_CheckBox.toolTip = "<p>Sets the OIII and SII black points so that their sky lands at the same brightness " +
      "as Ha's sky after the stretch. Prevents a tinted background when the lines have different noise levels. " +
      "Shadow clip then applies to Ha, and the other lines follow it.</p>";
   this.neutral_CheckBox.onCheck = function (checked) { data.neutralBackground = checked; dlg.schedulePreview(); };
   this.stretch_GroupBox.sizer.add(row([makeLabel(""), this.neutral_CheckBox], false));

   /*
    * Blend
    */
   this.mode_Combo = new ComboBox(this);
   for (var bi = 0; bi < BLEND_NAMES.length; ++bi)
      this.mode_Combo.addItem(BLEND_NAMES[bi]);
   this.mode_Combo.currentItem = data.blendMode;
   this.mode_Combo.toolTip = "<p><b>Foraxx (dynamic)</b> - the ForaxxPalette blend: HOO, or SHO when SII is selected.</p>" +
      "<p><b>Ratio color</b> - color from how OIII-dominated each pixel is (Ha color to OIII color), " +
      "brightness from the brightest line. SII pulls toward red-orange.</p>" +
      "<p><b>Classic palette</b> - fixed channel mixes (HOO, SHO, HSO, ...) with editable weights.</p>" +
      "<p><b>Custom PixelMath</b> - your own R, G, B expressions using H, O and S.</p>";
   this.mode_Combo.onItemSelected = function (index)
   {
      data.blendMode = index;
      applyModeDefaults(data);
      dlg.link_Control.setValue(data.link);
      dlg.finishing_CheckBox.checked = data.foraxxFinishing;
      dlg.updateModeControls();
      dlg.schedulePreview();
   };

   // Ratio color controls
   this.ratio_Control = new Control(this);
   this.ratio_Control.sizer = new VerticalSizer;
   this.ratio_Control.sizer.spacing = 4;

   this.preset_Combo = new ComboBox(this.ratio_Control);
   for (var pi = 0; pi < RATIO_PRESETS.length; ++pi)
      this.preset_Combo.addItem(RATIO_PRESETS[pi].name);
   this.preset_Combo.currentItem = data.ratioPreset;
   this.preset_Combo.onItemSelected = function (index) { data.ratioPreset = index; dlg.schedulePreview(); };

   this.balance_Control = numeric("Balance:", -100, 100, 0, 200, data.ratioBalance,
      "<p>Shifts where color turns from the Ha color to the OIII color. Positive values make more of the " +
      "nebula take the OIII color; negative values more of the Ha color. 0 centers the change on the nebula's " +
      "typical OIII/Ha ratio (measured automatically).</p>",
      function (v) { data.ratioBalance = v; }, this.ratio_Control);
   this.contrast_Control = numeric("Contrast:", 0.5, 10.0, 1, 95, data.ratioContrast,
      "<p>How sharply the color changes with the OIII/Ha ratio. Low values give gentle gradients; " +
      "high values separate Ha-dominated and OIII-dominated regions more strongly.</p>",
      function (v) { data.ratioContrast = v; }, this.ratio_Control);
   this.sii_Control = numeric("SII strength:", 0.0, 3.0, 2, 300, data.siiStrength,
      "<p>How strongly SII pulls the color toward red-orange (only with an SII image).</p>",
      function (v) { data.siiStrength = v; }, this.ratio_Control);

   this.brightness_Control = numeric("Brightness:", 0.5, 2.5, 2, 200, data.ratioBrightness,
      "<p>Overall brightness of the ratio color image. The tint colors are darker than white, so values above 1 " +
      "restore the brightness of the stretch.</p>",
      function (v) { data.ratioBrightness = v; }, this.ratio_Control);

   this.ratio_Control.sizer.add(row([makeLabel("Colors:", this.ratio_Control), this.preset_Combo], false));
   this.ratio_Control.sizer.add(this.balance_Control);
   this.ratio_Control.sizer.add(this.contrast_Control);
   this.ratio_Control.sizer.add(this.sii_Control);
   this.ratio_Control.sizer.add(this.brightness_Control);

   this.smoothing_Control = numeric("Color smoothing:", 0.0, 10.0, 1, 100, data.colorSmoothing,
      "<p>Blur radius (pixels) used only for the color, not the brightness. Color in nebulae varies slowly, so " +
      "smoothing the OIII/Ha ratio removes color noise (blue and gold speckle in faint areas) without losing " +
      "detail, which comes from the full-resolution brightness. 0 = off.</p>",
      function (v) { data.colorSmoothing = v; }, this.ratio_Control);
   this.ratio_Control.sizer.add(this.smoothing_Control);

   // Palette controls
   this.palette_Control = new Control(this);
   this.palette_Control.sizer = new VerticalSizer;
   this.palette_Control.sizer.spacing = 4;

   this.palette_Combo = new ComboBox(this.palette_Control);
   for (var pa = 0; pa < PALETTES.length; ++pa)
      this.palette_Combo.addItem(PALETTES[pa].name);
   this.palette_Combo.currentItem = data.paletteIndex;
   this.palette_Combo.onItemSelected = function (index)
   {
      data.paletteIndex = index;
      data.paletteWeights = copyWeights(PALETTES[index].w);
      dlg.refreshWeights();
      dlg.schedulePreview();
   };
   this.palette_Control.sizer.add(row([makeLabel("Palette:", this.palette_Control), this.palette_Combo], false));

   this.weightEdits = [];
   var chNames = ["R =", "G =", "B ="], lineSuffix = [" * H +", " * O +", " * S"];
   for (var c = 0; c < 3; ++c)
   {
      var wr = new HorizontalSizer;
      wr.spacing = 4;
      wr.add(makeLabel(chNames[c], this.palette_Control));
      this.weightEdits[c] = [];
      for (var k = 0; k < 3; ++k)
      {
         var ne = new NumericEdit(this.palette_Control);
         ne.setReal(true);
         ne.setPrecision(2);
         ne.setRange(0.0, 2.0);
         ne.enableFixedPrecision(true);
         ne.edit.setFixedWidth(48);
         ne.setValue(data.paletteWeights[c][k]);
         ne.onValueUpdated = (function (cc, kk) { return function (v) { data.paletteWeights[cc][kk] = v; dlg.schedulePreview(); }; })(c, k);
         this.weightEdits[c][k] = ne;
         wr.add(ne);
         var sl = new Label(this.palette_Control);
         sl.text = lineSuffix[k];
         sl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
         wr.add(sl);
      }
      wr.addStretch();
      this.palette_Control.sizer.add(wr);
   }
   this.refreshWeights = function ()
   {
      for (var c = 0; c < 3; ++c)
         for (var k = 0; k < 3; ++k)
            this.weightEdits[c][k].setValue(data.paletteWeights[c][k]);
   };

   // Custom controls
   this.custom_Control = new Control(this);
   this.custom_Control.sizer = new VerticalSizer;
   this.custom_Control.sizer.spacing = 4;
   function customEdit(label, value, onChange)
   {
      var ed = new Edit(dlg.custom_Control);
      ed.text = value;
      ed.toolTip = "<p>PixelMath expression using <b>H</b>, <b>O</b> and <b>S</b> (the stretched Ha, OIII and SII). " +
                   "Example: <i>0.5*H + 0.5*O</i></p>";
      ed.onTextUpdated = function (t) { onChange(t); dlg.schedulePreview(); };
      dlg.custom_Control.sizer.add(row([makeLabel(label, dlg.custom_Control), ed], true));
      return ed;
   }
   this.customR_Edit = customEdit("R =", data.customR, function (t) { data.customR = t; });
   this.customG_Edit = customEdit("G =", data.customG, function (t) { data.customG = t; });
   this.customB_Edit = customEdit("B =", data.customB, function (t) { data.customB = t; });

   // Shared finishing
   this.saturation_Control = numeric("Saturation:", 0.0, 3.0, 2, 300, data.saturation,
      "<p>Color saturation of the blended image (1 = unchanged), keeping brightness.</p>",
      function (v) { data.saturation = v; });

   this.blend_GroupBox = new GroupBox(this);
   this.blend_GroupBox.title = "Blend";
   this.blend_GroupBox.sizer = new VerticalSizer;
   this.blend_GroupBox.sizer.margin = 6;
   this.blend_GroupBox.sizer.spacing = 6;
   this.blend_GroupBox.sizer.add(row([makeLabel("Mode:"), this.mode_Combo], false));
   this.blend_GroupBox.sizer.add(this.ratio_Control);
   this.blend_GroupBox.sizer.add(this.palette_Control);
   this.blend_GroupBox.sizer.add(this.custom_Control);
   this.blend_GroupBox.sizer.add(this.saturation_Control);

   this.green_Control = numeric("Green reduction (%):", 0, 100, 0, 100, data.greenReduction,
      "<p>Removes green above the average of red and blue (like SCNR, average neutral). " +
      "Raw SHO is green-dominated because Ha, usually the strongest line, is mapped to green; " +
      "reducing the green shifts it toward the gold-and-blue Hubble-palette look. 0 = off.</p>",
      function (v) { data.greenReduction = v; });
   this.blend_GroupBox.sizer.add(this.green_Control);

   this.finishing_CheckBox = new CheckBox(this);
   this.finishing_CheckBox.text = "Foraxx finishing (hue and saturation curves)";
   this.finishing_CheckBox.checked = data.foraxxFinishing;
   this.finishing_CheckBox.toolTip = "<p>Applies the hue and saturation adjustments of the ForaxxPalette utility after " +
      "blending: reds pushed toward gold, blues deepened, and saturation boosted around gold and blue. " +
      "This is where most of the classic Foraxx gold-and-blue look comes from. Works with any blend mode.</p>" +
      "<p>Curve settings from Paul Hancock's ForaxxPalette utility.</p>";
   this.finishing_CheckBox.onCheck = function (checked) { data.foraxxFinishing = checked; dlg.schedulePreview(); };
   this.reset_Button = new PushButton(this);
   this.reset_Button.text = "Reset all sliders";
   this.reset_Button.toolTip = "<p>Puts every Stretch and Blend slider back to its default for the current blend mode " +
      "(including Link lines and Foraxx finishing). Input images, mode, color preset and custom expressions are kept.</p>";
   this.reset_Button.onClick = function ()
   {
      resetSliders(data);
      dlg.refreshControls();
      dlg.schedulePreview();
   };

   this.blend_GroupBox.sizer.add(row([makeLabel(""), this.finishing_CheckBox], false));

   // Reset sits between the Blend and Output boxes: it resets stretch and blend sliders
   this.reset_Sizer = new HorizontalSizer;
   this.reset_Sizer.addStretch();
   this.reset_Sizer.add(this.reset_Button);

   // Show the current settings in every control (after a reset)
   this.refreshControls = function ()
   {
      dlg.clip_Control.setValue(data.shadowClip);
      dlg.target_Control.setValue(data.targetMedian);
      dlg.link_Control.setValue(data.link);
      dlg.contrast_Control2.setValue(data.contrast);
      dlg.highlight_Control.setValue(data.highlightProtection);
      dlg.neutral_CheckBox.checked = data.neutralBackground;
      dlg.balance_Control.setValue(data.ratioBalance);
      dlg.contrast_Control.setValue(data.ratioContrast);
      dlg.sii_Control.setValue(data.siiStrength);
      dlg.brightness_Control.setValue(data.ratioBrightness);
      dlg.smoothing_Control.setValue(data.colorSmoothing);
      dlg.saturation_Control.setValue(data.saturation);
      dlg.green_Control.setValue(data.greenReduction);
      dlg.finishing_CheckBox.checked = data.foraxxFinishing;
      dlg.refreshWeights();
   };

   this.updateModeControls = function ()
   {
      if (data.blendMode == BLEND_RATIO) this.ratio_Control.show(); else this.ratio_Control.hide();
      if (data.blendMode == BLEND_PALETTE) this.palette_Control.show(); else this.palette_Control.hide();
      if (data.blendMode == BLEND_CUSTOM) this.custom_Control.show(); else this.custom_Control.hide();
      this.adjustToContents();
   };

   // Output
   this.keep_CheckBox = new CheckBox(this);
   this.keep_CheckBox.text = "Keep stretched mono lines (_HA_s, _OIII_s, _SII_s)";
   this.keep_CheckBox.checked = data.keepMono;
   this.keep_CheckBox.onCheck = function (checked) { data.keepMono = checked; };

   this.output_GroupBox = new GroupBox(this);
   this.output_GroupBox.title = "Output";
   this.output_GroupBox.sizer = new VerticalSizer;
   this.output_GroupBox.sizer.margin = 6;
   this.output_GroupBox.sizer.add(row([makeLabel(""), this.keep_CheckBox], false));

   // Buttons
   this.newInstanceButton = new ToolButton(this);
   this.newInstanceButton.icon = this.scaledResource(":/process-interface/new-instance.png");
   this.newInstanceButton.setScaledFixedSize(24, 24);
   this.newInstanceButton.toolTip = "New Instance";
   this.newInstanceButton.onMousePress = function ()
   {
      this.hasFocus = true;
      this.pushed = false;
      data.setParameters();
      this.dialog.newInstance();
   };

   this.ok_Button = new PushButton(this);
   this.ok_Button.text = "Apply";
   this.ok_Button.cursor = new Cursor(StdCursor_Checkmark);
   this.ok_Button.onClick = function () { this.dialog.ok(); };

   this.cancel_Button = new PushButton(this);
   this.cancel_Button.text = "Close";
   this.cancel_Button.cursor = new Cursor(StdCursor_Crossmark);
   this.cancel_Button.onClick = function () { this.dialog.cancel(); };

   this.help_Button = new PushButton(this);
   this.help_Button.text = "Help";
   try { this.help_Button.icon = this.scaledResource(":/process-interface/browse-documentation.png"); } catch (e) { }
   this.help_Button.toolTip = "<p>Open an easy guide to every setting, with recipes and troubleshooting.</p>";
   this.help_Button.onClick = function () { (new HelpDialog()).execute(); };

   this.buttons_Sizer = new HorizontalSizer;
   this.buttons_Sizer.spacing = 6;
   this.buttons_Sizer.add(this.newInstanceButton);
   this.buttons_Sizer.add(this.help_Button);
   this.buttons_Sizer.addStretch();
   this.buttons_Sizer.add(this.ok_Button);
   this.buttons_Sizer.add(this.cancel_Button);

   /*
    * Live preview
    */
   this.previewEngine = new PreviewEngine();
   this.previewBitmap = null;
   this.previewMessage = "Preview will appear here.";
   this.previewShow = SHOW_BLEND;
   this.liveUpdate = true;
   this.previewZoom = 0;            // 0 = fit, 1 = 100% (1:1)
   this.previewQuality = 0;         // index into PREVIEW_QUALITY
   this.previewCenter = null;       // 1:1 view center in image pixels
   this.previewInfo = null;         // what the current bitmap shows
   this.previewGeom = null;         // where it was drawn: { ox, oy, scale }
   this.drag = null;                // { x, y, dx, dy } while panning at 1:1

   this.preview_Control = new Control(this);
   this.preview_Control.setScaledMinSize(PREVIEW_SIZE, Math.round(PREVIEW_SIZE * 0.72));
   this.preview_Control.toolTip = "<p>Double-click to zoom to 100% at that point; double-click again to fit. " +
      "At 100%, drag to pan.</p>";
   this.preview_Control.onPaint = function (x0, y0, x1, y1)
   {
      var g = new Graphics(this);
      g.fillRect(0, 0, this.width, this.height, new Brush(0xff1e1e1e));
      var bmp = dlg.previewBitmap;
      dlg.previewGeom = null;
      if (bmp != null)
      {
         // Fit: scale down (never up) to the panel. 1:1: one image pixel per screen pixel.
         var scale = (dlg.previewInfo && dlg.previewInfo.zoom == 1) ? 1 :
                     Math.min(this.width / bmp.width, this.height / bmp.height);
         var w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
         var ox = Math.floor((this.width - w) / 2), oy = Math.floor((this.height - h) / 2);
         if (dlg.drag != null)
         {
            ox += dlg.drag.dx;
            oy += dlg.drag.dy;
         }
         dlg.previewGeom = { ox: ox, oy: oy, scale: scale };
         try { g.smoothInterpolation = true; } catch (e0) {}
         if (scale == 1)
            g.drawBitmap(ox, oy, bmp);
         else
         {
            try
            {
               g.drawScaledBitmap(new Rect(ox, oy, ox + w, oy + h), bmp);
            }
            catch (e)
            {
               g.drawBitmap(ox, oy, bmp.scaledTo(w, h));
            }
         }
      }
      if (dlg.previewMessage)
      {
         g.pen = new Pen(0xffd0d0d0);
         g.drawText(10, 20, dlg.previewMessage);
      }
      g.end();
   };

   // Recompute when the panel changes size, so the preview always matches the screen
   this.preview_Control.onResize = function (wNew, hNew, wOld, hOld)
   {
      if (dlg.previewInfo != null)
         dlg.schedulePreview(true);
   };

   // Panel point -> full-resolution image point, from the current bitmap
   this.imagePointAt = function (x, y)
   {
      var info = dlg.previewInfo, geo = dlg.previewGeom;
      if (info == null || geo == null)
         return null;
      var bx = (x - geo.ox) / geo.scale, by = (y - geo.oy) / geo.scale;
      if (info.zoom == 1)
         return { x: info.x0 + bx, y: info.y0 + by };
      return { x: bx * info.factor, y: by * info.factor };
   };

   this.preview_Control.onMouseDoubleClick = function (x, y, buttonState, modifiers)
   {
      if (dlg.previewZoom == 0)
      {
         var p = dlg.imagePointAt(x, y);
         if (p == null) return;
         dlg.previewCenter = p;
         dlg.setZoom(1);
      }
      else
         dlg.setZoom(0);
   };

   this.preview_Control.onMousePress = function (x, y, button, buttonState, modifiers)
   {
      if (dlg.previewZoom == 1 && dlg.previewInfo != null && dlg.previewInfo.zoom == 1)
         dlg.drag = { x: x, y: y, dx: 0, dy: 0 };
   };

   this.preview_Control.onMouseMove = function (x, y, buttonState, modifiers)
   {
      if (dlg.drag == null) return;
      dlg.drag.dx = x - dlg.drag.x;
      dlg.drag.dy = y - dlg.drag.y;
      this.update();
   };

   this.preview_Control.onMouseRelease = function (x, y, button, buttonState, modifiers)
   {
      if (dlg.drag == null) return;
      var d = dlg.drag;
      dlg.drag = null;
      if (Math.abs(d.dx) + Math.abs(d.dy) < 2) { this.update(); return; }
      var c = dlg.previewInfo.center;
      dlg.previewCenter = { x: c.x - d.dx, y: c.y - d.dy };
      // Keep the moved bitmap on screen until the new crop is ready
      dlg.updatePreview();
   };

   this.setZoom = function (zoom)
   {
      dlg.previewZoom = zoom;
      dlg.drag = null;
      if (dlg.zoom_Combo.currentItem != zoom)
         dlg.zoom_Combo.currentItem = zoom;
      dlg.quality_Combo.enabled = zoom == 0;
      dlg.updatePreview();
   };

   this.show_Combo = new ComboBox(this);
   for (var si = 0; si < SHOW_NAMES.length; ++si)
      this.show_Combo.addItem(SHOW_NAMES[si]);
   this.show_Combo.currentItem = this.previewShow;
   this.show_Combo.onItemSelected = function (index) { dlg.previewShow = index; dlg.schedulePreview(true); };

   this.zoom_Combo = new ComboBox(this);
   this.zoom_Combo.addItem("Fit");
   this.zoom_Combo.addItem("100% (1:1)");
   this.zoom_Combo.currentItem = 0;
   this.zoom_Combo.toolTip = "<p><b>Fit</b> shows the whole image at your screen's full resolution. " +
      "<b>100%</b> shows real pixels, as Apply will produce them. You can also double-click the preview.</p>";
   this.zoom_Combo.onItemSelected = function (index)
   {
      dlg.setZoom(index);
   };

   this.quality_Combo = new ComboBox(this);
   for (var qi = 0; qi < PREVIEW_QUALITY_NAMES.length; ++qi)
      this.quality_Combo.addItem(PREVIEW_QUALITY_NAMES[qi]);
   this.quality_Combo.currentItem = this.previewQuality;
   this.quality_Combo.toolTip = "<p><b>Sharp</b> (recommended) computes the preview at your screen's full resolution. " +
      "<b>Balanced</b> (70%) and <b>Fast</b> (50%) compute fewer pixels and enlarge them, so they update faster " +
      "on slow computers but look softer.</p>";
   this.quality_Combo.onItemSelected = function (index) { dlg.previewQuality = index; dlg.schedulePreview(true); };

   this.live_CheckBox = new CheckBox(this);
   this.live_CheckBox.text = "Live update";
   this.live_CheckBox.checked = this.liveUpdate;
   this.live_CheckBox.toolTip = "<p>Update the preview automatically after each change.</p>";
   this.live_CheckBox.onCheck = function (checked) { dlg.liveUpdate = checked; if (checked) dlg.schedulePreview(); };

   this.refresh_Button = new PushButton(this);
   this.refresh_Button.text = "Refresh";
   this.refresh_Button.onClick = function () { dlg.updatePreview(); };

   this.previewStatus_Label = new Label(this);
   this.previewStatus_Label.text = "";
   this.previewStatus_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   function topLabel(dialog, text)
   {
      var l = new Label(dialog);
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      return l;
   }

   var previewTop = new HorizontalSizer;
   previewTop.spacing = 6;
   previewTop.add(topLabel(this, "Show:"));
   previewTop.add(this.show_Combo);
   previewTop.addSpacing(10);
   previewTop.add(topLabel(this, "Zoom:"));
   previewTop.add(this.zoom_Combo);
   previewTop.addSpacing(10);
   previewTop.add(topLabel(this, "Quality:"));
   previewTop.add(this.quality_Combo);
   previewTop.addSpacing(10);
   previewTop.add(this.live_CheckBox);
   previewTop.addStretch();
   previewTop.add(this.refresh_Button);

   this.preview_GroupBox = new GroupBox(this);
   this.preview_GroupBox.title = "Preview";
   this.preview_GroupBox.sizer = new VerticalSizer;
   this.preview_GroupBox.sizer.margin = 6;
   this.preview_GroupBox.sizer.spacing = 6;
   this.preview_GroupBox.sizer.add(previewTop);
   this.preview_GroupBox.sizer.add(this.preview_Control, 100);
   this.preview_GroupBox.sizer.add(this.previewStatus_Label);

   // Debounced updates: run ~0.35 s after the last change
   this.previewTimer = new Timer;
   this.previewTimer.interval = 0.35;
   this.previewTimer.periodic = false;
   this.previewTimer.onTimeout = function () { dlg.updatePreview(); };

   /*
    * Only one preview update runs at a time. PixInsight keeps the window
    * responsive while the preview is computed, so a slider, zoom or Show
    * change (or the timer) can arrive in the middle of an update. Starting a
    * second update then would close images the first one is still using
    * (an error message, or a PixInsight crash). Instead the request is
    * remembered and runs once the current update has finished. If the
    * window closes during an update, the update cleans up after itself.
    */
   this.previewBusy = false;
   this.previewPending = false;
   this.previewClosing = false;

   this.schedulePreview = function (force)
   {
      if (!force && !dlg.liveUpdate)
         return;
      if (dlg.previewClosing)
         return;
      dlg.previewTimer.stop();
      dlg.previewTimer.start();
   };

   this.updatePreview = function ()
   {
      dlg.previewTimer.stop();
      if (dlg.previewClosing)
         return;
      if (dlg.previewBusy)
      {
         dlg.previewPending = true;
         return;
      }
      dlg.previewBusy = true;
      dlg.previewPending = false;
      try
      {
         dlg.runPreview();
      }
      finally
      {
         dlg.previewBusy = false;
      }
      if (dlg.previewClosing)
      {
         // The window was closed while this update ran: clean up now
         dlg.previewEngine.close();
         return;
      }
      if (dlg.previewPending)
      {
         // Something changed meanwhile: update again (after the current event finishes)
         dlg.previewPending = false;
         dlg.schedulePreview(true);
      }
   };

   this.runPreview = function ()
   {
      var t0 = Date.now();
      var temp = [];
      try
      {
         if (!isValidView(data.ha) || !isValidView(data.oiii))
         {
            dlg.previewBitmap = null;
            dlg.previewInfo = null;
            dlg.previewMessage = "Select the Ha and OIII images.";
            dlg.preview_Control.update();
            return;
         }
         if (dlg.previewInfo == null)
         {
            dlg.previewMessage = "Measuring the images (first time only)...";
            dlg.preview_Control.update();
            processEvents();
         }
         // Preview area in physical (device) pixels
         var pw = dlg.preview_Control.width, ph = dlg.preview_Control.height;
         var q = dlg.previewZoom == 0 ? PREVIEW_QUALITY[dlg.previewQuality] : 1;
         var res = dlg.previewEngine.compute(data, dlg.previewShow, pw * q, ph * q,
                                             dlg.previewZoom, dlg.previewCenter);
         temp = res.temp;
         if (dlg.previewClosing)
         {
            for (var j = 0; j < temp.length; ++j)
               closeById(temp[j]);
            return;
         }
         dlg.previewBitmap = imageToBitmap(View.viewById(res.id));
         dlg.previewInfo = res.info;
         dlg.drag = null;
         if (res.info.zoom == 1)
            dlg.previewCenter = res.info.center;
         var warn = dlg.previewShow == SHOW_BLEND ? blendWarning(data) : "";
         dlg.previewMessage = warn ? "Warning: " + warn : "";
         var secs = (Date.now() - t0) / 1000;
         if (res.info.zoom == 1)
            dlg.previewStatus_Label.text = format("Preview at 100%% (1:1), %dx%d pixels - drag to pan, double-click to fit  (%.1f s)",
                                                  res.info.w, res.info.h, secs);
         else
         {
            var img = data.ha.image;
            var eff = Math.max(1, img.width / pw, img.height / ph);
            dlg.previewStatus_Label.text = format("Preview fit to screen at 1:%.1f - double-click to zoom to 100%% there  (%.1f s)",
                                                  eff, secs);
         }
      }
      catch (e)
      {
         dlg.previewBitmap = null;
         dlg.previewInfo = null;
         dlg.drag = null;
         dlg.previewMessage = "Preview error: " + e.message;
         dlg.previewStatus_Label.text = "";
      }
      for (var i = 0; i < temp.length; ++i)
         closeById(temp[i]);
      dlg.preview_Control.update();
   };

   this.onShow = function ()
   {
      dlg.previewClosing = false;
      dlg.previewPending = false;
      dlg.schedulePreview(true);
   };

   this.onHide = function ()
   {
      dlg.previewTimer.stop();
      dlg.previewClosing = true;
      // If an update is running, it closes the preview images when it finishes
      if (!dlg.previewBusy)
         dlg.previewEngine.close();
   };

   var leftColumn = new VerticalSizer;
   leftColumn.spacing = 6;
   leftColumn.add(this.input_GroupBox);
   leftColumn.add(this.stretch_GroupBox);
   leftColumn.add(this.blend_GroupBox);
   leftColumn.add(this.reset_Sizer);
   leftColumn.add(this.output_GroupBox);
   leftColumn.addStretch();

   var columns = new HorizontalSizer;
   columns.spacing = 8;
   columns.add(leftColumn);
   columns.add(this.preview_GroupBox, 100);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 6;
   this.sizer.spacing = 6;
   this.sizer.add(this.headerLabel);
   this.sizer.add(this.helpLabel);
   this.sizer.add(columns, 100);
   this.sizer.addSpacing(6);
   this.sizer.add(this.buttons_Sizer);

   this.windowTitle = TITLE;
   this.updateModeControls();
}

NarrowbandDialog.prototype = new Dialog;

function main()
{
   Console.writeln("");
   Console.noteln("<b>", TITLE, " ", VERSION, "</b>");

   data.getParameters();

   if (Parameters.isGlobalTarget && isValidView(data.ha) && isValidView(data.oiii))
   {
      NarrowbandStart(data);
      return;
   }

   data.autoPick();
   clearMeasureCache();
   var dialog = new NarrowbandDialog();
   for (;;)
   {
      if (!dialog.execute())
         break;
      NarrowbandStart(data);
   }
   dialog.previewTimer.stop();
   dialog.previewEngine.close();
}

main();
