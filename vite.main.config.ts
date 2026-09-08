import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Test doubles are reachable only from the explicitly requested E2E package.
  resolve: {
    alias:
      process.env.STUDYAPP_E2E_BUILD === '1'
        ? [
            {
              find: './providerRuntime',
              replacement: resolve('tests/testkit/e2eProviderRuntime.ts'),
            },
            {
              find: './contentPipelineRuntime',
              replacement: resolve('tests/testkit/e2eContentRuntime.ts'),
            },
          ]
        : [],
  },
  define: {
    __STUDYAPP_E2E_BUILD__: JSON.stringify(process.env.STUDYAPP_E2E_BUILD === '1'),
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
      },
    },
    sourcemap: false,
  },
});
