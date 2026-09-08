import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node24',
    outDir: '.vite/build',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: 'src/infrastructure/metadata/metadataWorker.ts',
      formats: ['es'],
      fileName: () => 'metadata-worker.mjs',
    },
    rollupOptions: {
      external: [/^node:/u, /^pdfjs-dist\//u, 'pdf-lib', 'music-metadata', 'yauzl', 'zod'],
      output: { format: 'es' },
    },
  },
});
