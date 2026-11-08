# NarrowbandProcessing

A script for **PixInsight** and **Siril** that stretches and blends narrowband line images (Hα, OIII and optional SII) into color images: Foraxx, HOO, SHO and more, with a live preview.

Both versions use the same processing and give the same results.

It works with:

- **Mono cameras** with separate Hα / OIII / SII filters: use your stacked masters directly.
- **One-shot color cameras with dual-band filters** (L-eNhance, L-eXtreme, ...): extract the lines first (DBXtract in PixInsight, or Siril's Ha/OIII extraction), then open NarrowbandProcessing. In PixInsight it picks up the `_HA`, `_OIII` and `_SII` images automatically.

The input images must be **linear** (not stretched yet) and registered to each other.

## Features

**Stretch**
- Black point set from the real sky background rather than the single darkest pixel, with a clipping guard for nebulae that fill the whole frame.
- **Link lines:** from equal brightness for every line (what Foraxx and classic palettes expect) to true relative brightness (cleaner shadows, less noise).
- Neutral background, contrast and **highlight protection** for very bright cores such as M42.

**Blend**
- **Foraxx (dynamic):** HOO, or SHO when SII is selected.
- **Ratio color:** color from the OIII/Hα ratio, with presets such as Gold + blue core, automatic balance and color smoothing.
- **Classic palettes:** HOO, SHO, HSO and more, with editable weights.
- **Custom PixelMath** using H, O and S.
- Saturation, green reduction (SCNR-style) and **Foraxx finishing** (hue and saturation curves).

**Also:** live preview, Reset all sliders, and a built-in guide (**Help** button) with recipes and troubleshooting.

## Installation

### From the PixInsight update repository (recommended)

1. In PixInsight, open **Resources > Updates > Manage Repositories**.
2. Click **Add** and enter:
   ```
   https://raw.githubusercontent.com/justinthedark/NarrowbandProcessing/main/
   ```
3. Click **OK**, then **Resources > Updates > Check for Updates**, and install NarrowbandProcessing.
4. Restart PixInsight when asked.
5. Open **Script > Utilities > NarrowbandProcessing**.

Future versions then arrive through **Check for Updates** automatically.

### Manual installation

1. Download `src/scripts/NarrowbandProcessing/NarrowbandProcessing.js`.
2. In PixInsight, use **Script > Feature Scripts > Add**, choose the folder containing the file, and click **Done**. The script then appears under **Script > Utilities**.

### Siril (1.4 or newer)

1. Download [`siril/NarrowbandProcessing.py`](siril/NarrowbandProcessing.py) and put it in a folder of your choice (for example `Documents/Siril scripts`).
2. In Siril, open **Preferences > Scripts** and add that folder to the script folders.
3. The script appears in Siril's **Scripts** menu (restart Siril or refresh the script list if needed).
4. The first run installs numpy, scipy and PyQt6 automatically if they are missing.

In Siril, choose the linear Hα, OIII and SII FITS files in the script's window. **Apply** saves the result (`NB_Foraxx.fit`, `NB_Ratio.fit`, ...) in Siril's working folder and opens it.

## Quick start

1. Open your linear Hα and OIII images (and SII if you have it). In Siril, choose them as FITS files in the script's window instead.
2. Run **Script > Utilities > NarrowbandProcessing** (PixInsight) or **Scripts > NarrowbandProcessing** (Siril).
3. Choose a blend **Mode**. Foraxx is a good starting point.
4. Adjust Contrast, Highlight protection and Saturation while watching the preview. Double-click the preview to check real pixels at 100%.
5. Click **Apply**.

Click **Help** in the script for a full guide to every setting.

## Differences between the versions

- PixInsight works on open images; Siril reads linear FITS files that you choose in the script's window (32-bit float or 16/32-bit integer FITS; compressed FITS is not supported).
- Siril's Foraxx finishing applies the same curve settings in HSV space, so colors can differ very slightly from PixInsight's.

## Credits

- Foraxx palette and Foraxx finishing curve settings: Paul Hancock's ForaxxPalette utility and the Foraxx palette by The Coldest Nights.
- Built on PixInsight (Pleiades Astrophoto).

## License

Copyright © 2026 Justin Pickens.

NarrowbandProcessing is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3. See [LICENSE](LICENSE).
