import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build config for the mobile PWA. Separate from the desktop renderer:
// root is mobile/, output is dist-mobile/, served by electron/mobile-server.js.
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
  },
});
