import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: resolve(process.cwd(), 'src/renderer'),
  build: {
    outDir: resolve(process.cwd(), '.vite/renderer/main_window'),
    sourcemap: false,
  },
});
