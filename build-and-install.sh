#!/bin/bash
set -e

echo "=== Dobius+ Build & Install ==="

echo "1. Building Vite frontend..."
npm run build

echo "2. Building Electron app..."
rm -rf dist-electron
npx electron-builder --mac

echo "3. Installing to /Applications..."
# Graceful quit — lets the app save terminal scrollback before exiting
osascript -e 'tell application "Dobius+" to quit' 2>/dev/null || true
sleep 3
# Only force-kill if graceful quit didn't work
pkill -f "Dobius+" 2>/dev/null || true
sleep 1

rm -rf "/Applications/Dobius+.app"

# Clear Electron caches to prevent stale renders after rebuild
APPDATA="$HOME/Library/Application Support/dobius-plus"
rm -rf "$APPDATA/Cache" "$APPDATA/Code Cache" "$APPDATA/GPUCache" "$APPDATA/DawnGraphiteCache" "$APPDATA/DawnWebGPUCache" 2>/dev/null || true

DMG=$(ls -t dist-electron/*.dmg 2>/dev/null | head -1)
if [ -z "$DMG" ]; then
  echo "ERROR: No DMG found in dist-electron/"
  exit 1
fi
echo "   Mounting $DMG..."
hdiutil attach "$DMG" -nobrowse -quiet
VOLUME=$(ls -d /Volumes/Dobius+* | head -1)
cp -R "$VOLUME/Dobius+.app" "/Applications/"
hdiutil detach "$VOLUME" -quiet

echo "=== Installed to /Applications/Dobius+.app ==="
open "/Applications/Dobius+.app"
