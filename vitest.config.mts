import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'mobile/scriptable/**/*.js'],
      exclude: [
        'src/main/index.ts',
        'src/main/bootstrap.ts',
        'src/preload/index.ts',
        'src/renderer/main.tsx',
        'src/shared/types/**',
      ],
      reporter: ['text', 'text-summary', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
