#!/bin/bash
# Install the freshly built dobius/ v2 app into /Applications/Dobius+.app.
# Run DETACHED (nohup) — the installer must outlive the app it replaces,
# because Claude sessions run inside that app. Logs to /tmp/dobius-install.log.
# Assumes `pnpm run build:unpack` already succeeded (build first, install second).
set -euo pipefail

REPO="/Users/bayou/Projects (Code)/dobius-plus"
BUILT_APP="$REPO/dobius/dist/mac-arm64/Dobius+.app"
INSTALLED="/Applications/Dobius+.app"
APPDATA="$HOME/Library/Application Support/dobius-plus"

echo "=== install-dobius-v2 $(date) ==="

if [ ! -d "$BUILT_APP" ]; then
  echo "ERROR: built app not found at: $BUILT_APP (run pnpm run build:unpack first)" >&2
  exit 1
fi

echo "1/4 Graceful quit (daemon persists terminal sessions), then hard-stop"
osascript -e 'tell application "Dobius+" to quit' 2>/dev/null || true
sleep 4
# Kill only the main app process (exact name) and lingering Chromium helpers
# (--type= arg). NEVER pattern-match the whole bundle path: the detached
# terminal daemon runs "Dobius+ Helper ... daemon-entry.js" from inside the
# bundle, and killing it destroys every live terminal session.
pkill -x "Dobius+" 2>/dev/null || true
pkill -f "Dobius\+ Helper.*--type=" 2>/dev/null || true
sleep 1

echo "2/4 Remove old app + clear Electron render caches"
rm -rf "$INSTALLED"
rm -rf "$APPDATA/Cache" "$APPDATA/Code Cache" "$APPDATA/GPUCache" \
       "$APPDATA/DawnGraphiteCache" "$APPDATA/DawnWebGPUCache" 2>/dev/null || true

echo "3/4 Copy new build (ditto preserves signature/xattrs)"
ditto "$BUILT_APP" "$INSTALLED"

echo "4/4 Relaunch"
open "$INSTALLED"
echo "=== done: $(date) — installed $(defaults read "$INSTALLED/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?') ==="
