import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build config for the mobile PWA. Separate from the desktop renderer:
// root is mobile/, output is dist-mobile/, served by electron/mobile-server.js.
// fs.allow lets the mobile build reach into ../src/ so the Office v2 canvas
// renderer modules (sprites, scene, camera, renderer) are shared with the
// desktop Office without duplicating ~700 LOC of pixel art + scene code.
// Use fileURLToPath so a project path with spaces (ours is "Projects (Code)")
// is not URL-encoded in the allow list.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: 'mobile',
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist-mobile',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    fs: { allow: [projectRoot] },
  },
});
