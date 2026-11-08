# NarrowbandProcessing

A PixInsight script that stretches and blends narrowband line images (Hα, OIII and optional SII) into colour images: Foraxx, HOO, SHO and more, with a live preview.

It works with:

- **Mono cameras** with separate Hα / OIII / SII filters: use your stacked masters directly.
- **One-shot colour cameras with dual-band filters** (L-eNhance, L-eXtreme, ...): extract the lines first with DBXtract, then open NarrowbandProcessing. It picks up the `_HA`, `_OIII` and `_SII` images automatically.

The input images must be **linear** (not stretched yet) and registered to each other.

## Features

**Stretch**
- Black point set from the real sky background rather than the single darkest pixel, with a clipping guard for nebulae that fill the whole frame.
- **Link lines:** from equal brightness for every line (what Foraxx and classic palettes expect) to true relative brightness (cleaner shadows, less noise).
- Neutral background, contrast and **highlight protection** for very bright cores such as M42.

**Blend**
- **Foraxx (dynamic):** HOO, or SHO when SII is selected.
- **Ratio colour:** colour from the OIII/Hα ratio, with presets such as Gold + blue core, automatic balance and colour smoothing.
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

## Quick start

1. Open your linear Hα and OIII images (and SII if you have it).
2. Run **Script > Utilities > NarrowbandProcessing**.
3. Choose a blend **Mode**. Foraxx is a good starting point.
4. Adjust Contrast, Highlight protection and Saturation while watching the preview.
5. Click **Apply**.

Click **Help** in the script for a full guide to every setting.

## Credits

- Foraxx palette and Foraxx finishing curve settings: Paul Hancock's ForaxxPalette utility and the Foraxx palette by The Coldest Nights.
- Built on PixInsight (Pleiades Astrophoto).

## License

Copyright © 2026 Justin Pickens.

NarrowbandProcessing is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3. See [LICENSE](LICENSE).
