import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');

// Standalone vite project rooted here. Resolves react from the project
// node_modules (not scripts/) and allows deep imports back into main src/.
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { preserveSymlinks: false },
  cacheDir: path.resolve(projectRoot, 'node_modules/.vite-office-harness'),
  optimizeDeps: {
    entries: [path.resolve(here, 'main.jsx')],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand'],
  },
  server: {
    port: 5175,
    fs: { allow: [projectRoot] },
  },
});
