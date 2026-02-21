# Task 5.1 Plan — Build, Package, and Install

## Goal
Set up electron-builder and create the build/install pipeline.

## Files to Create
- build/icon.png — Placeholder icon (256x256)
- electron-builder.yml — electron-builder configuration
- build-and-install.sh — Build + install to /Applications script

## Design
1. Create placeholder icon using canvas or a simple script
2. electron-builder.yml with mac DMG target, node-pty included in files
3. build-and-install.sh: build Vite, run electron-builder, mount DMG, copy to /Applications
