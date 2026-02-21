# Task 5.1 Review — Build, Package, and Install

## Files Created
- build/icon.png — 512x512 placeholder icon (dark bg with D+ in accent color)
- electron-builder.yml — electron-builder config (mac DMG, node-pty included)
- build-and-install.sh — Build + install pipeline script

## Review Checklist
- [x] Icon meets electron-builder minimum size requirement (512x512)
- [x] electron-builder.yml includes node-pty in files list
- [x] DMG builds successfully: Dobius+-1.0.0-arm64.dmg
- [x] build-and-install.sh is executable
- [x] Script kills existing app before install
- [x] Script removes old .app before copying (avoids asar overwrite issue)
- [x] Script opens app after install
- [x] Vite build passes (59 modules)
- [x] electron-builder packages correctly with ad-hoc signing

## Issues Found
- Initial icon was 256x256, electron-builder requires 512x512 minimum. Regenerated at 512x512.
