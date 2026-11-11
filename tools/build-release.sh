#!/bin/sh
# Builds a release package and updates updates.xri.
# Usage (from the repository root):  sh tools/build-release.sh 1.1.1 "Short description of the changes"
#
# Signed release, in this order:
#   1. Set #define VERSION in the script to the new version.
#   2. In PixInsight, sign the script with Script > Development > CodeSign
#      (creates NarrowbandProcessing.xsgn next to the script).
#   3. Run this script. It packages the script and its signature, and rewrites updates.xri.
#   4. Sign updates.xri with CodeSign LAST (it contains the package checksum).
#   Any change to the script after step 2 means signing it again.
set -e
VERSION="$1"
NOTES="$2"
if [ -z "$VERSION" ]; then
   echo "Usage: sh tools/build-release.sh <version> \"<release notes>\""
   exit 1
fi
SCRIPT=src/scripts/NarrowbandProcessing/NarrowbandProcessing.js
if ! grep -q "#define VERSION \"$VERSION\"" "$SCRIPT"; then
   echo "Error: $SCRIPT does not contain #define VERSION \"$VERSION\""
   exit 1
fi
SIGNATURE=src/scripts/NarrowbandProcessing/NarrowbandProcessing.xsgn
if [ ! -f "$SIGNATURE" ]; then
   echo "Error: $SIGNATURE not found."
   echo "Sign the script first: in PixInsight, Script > Development > CodeSign."
   exit 1
fi
if [ "$SCRIPT" -nt "$SIGNATURE" ]; then
   echo "Error: the script was changed after it was signed. Sign it again with CodeSign."
   exit 1
fi
ZIP="NarrowbandProcessing-$VERSION.zip"
rm -f "$ZIP"
zip -X -q "$ZIP" "$SCRIPT" "$SIGNATURE"
if command -v sha1sum >/dev/null 2>&1; then
   SHA=$(sha1sum "$ZIP" | cut -d' ' -f1)
else
   SHA=$(shasum -a 1 "$ZIP" | cut -d' ' -f1)
fi
DATE=$(date +%Y%m%d)
cat > updates.xri <<XRI
<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>NarrowbandProcessing: stretching and blending of narrowband Ha, OIII and SII line images into HOO, SHO and Foraxx color images, with a live preview.</p>
      <p>Copyright (C) 2026 Justin Pickens. Released under the GNU General Public License v3.</p>
   </description>
   <platform os="all" arch="noarch" version="1.8.9:2.9.9">
      <package fileName="$ZIP" sha1="$SHA" type="script" releaseDate="$DATE">
         <title>NarrowbandProcessing $VERSION</title>
         <description>
            <p>$NOTES</p>
            <p>After installing, restart PixInsight and open Script &gt; Utilities &gt; NarrowbandProcessing.</p>
         </description>
      </package>
   </platform>
</xri>
XRI
echo "Built $ZIP (script + signature, sha1 $SHA) and updated updates.xri."
echo ""
echo "NEXT: sign updates.xri with Script > Development > CodeSign in PixInsight."
echo "Do not change updates.xri or the zip after signing, or the signature breaks."
echo "Then upload the zip, updates.xri, the script and its .xsgn file (you can delete the previous version's zip)."
