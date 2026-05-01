import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const basePath = process.env.GH_PAGES_BASE_PATH || process.env.VITE_BASE_PATH;

export default defineConfig({
  plugins: [react()],
  base: basePath || './'
});
