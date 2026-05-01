import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const basePath = process.env.GH_PAGES_BASE_PATH || process.env.VITE_BASE_PATH;
const webDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webDir,
  plugins: [react()],
  base: basePath || './',
  build: {
    outDir: resolve(webDir, 'dist')
  }
});
