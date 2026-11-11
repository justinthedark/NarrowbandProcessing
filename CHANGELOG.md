# Changelog

## PixInsight 1.1.1

- Digitally signed: the script and its update repository are now signed with a Certified PixInsight Developer signature, so PixInsight no longer shows the unsigned-repository warning (once your PixInsight includes the latest list of certified developers).
- No changes to processing.

## PixInsight 1.1

- Sharper live preview: computed at the preview panel's real screen resolution (including Retina / 4K screens) and recomputed when the window is resized.
- **Zoom**: Fit or 100% (1:1). Double-click the preview to zoom to 100% at that point and again to go back to Fit; drag to pan at 100%. The 100% view matches Apply pixel for pixel, including ratio color, which keeps the whole image's color balance.
- **Quality**: Sharp (recommended), Balanced (70%) or Fast (50%) for slower computers. Affects only the preview.
- American spelling throughout (color, center, gray). Process icons saved with 1.0 still load.
- Help guide: updated Preview section.

## Siril 1.2

- Sharper live preview at your screen's full resolution, recomputed on resize.
- Zoom Fit / 100% (1:1) with double-click and drag to pan; Quality Sharp / Balanced / Fast.
- Faster Foraxx finishing (curve lookup tables).
- American spelling throughout (color, center, gray).

## Siril 1.1

- Interface rebuilt with PyQt6, following Siril's script guidelines.
- Custom expressions may use comparisons (`<`, `>`, `=`).
- Settings are checked and clamped when loaded.
- Help guide list numbering fixed.

## Siril 1.0.1

- Fixed white-on-white text on macOS.

## Siril 1.0

- First Siril version: same stretch and blend engine as PixInsight 1.0, reading linear FITS files.

## PixInsight 1.0

- First public release: sky-based stretch with clipping guard, line linking, neutral background, contrast and highlight protection; Foraxx, ratio color, classic palettes and custom PixelMath; saturation, green reduction and Foraxx finishing; live preview, Reset all sliders and a built-in Help guide.
- Packaged as a PixInsight update repository.
