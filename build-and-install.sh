#!/bin/bash
set -e

echo "=== Dobius+ Build & Install ==="

echo "1. Building Vite frontend..."
npm run build

echo "2. Building Electron app..."
rm -rf dist-electron
npx electron-builder --mac

echo "3. Installing to /Applications..."
osascript -e 'tell application "Dobius+" to quit' 2>/dev/null || true
pkill -f "Dobius+" 2>/dev/null || true
sleep 1

rm -rf "/Applications/Dobius+.app"

DMG=$(ls -t dist-electron/*.dmg | head -1)
echo "   Mounting $DMG..."
hdiutil attach "$DMG" -nobrowse -quiet
VOLUME=$(ls -d /Volumes/Dobius+* | head -1)
cp -R "$VOLUME/Dobius+.app" "/Applications/"
hdiutil detach "$VOLUME" -quiet

echo "=== Installed to /Applications/Dobius+.app ==="
open "/Applications/Dobius+.app"
