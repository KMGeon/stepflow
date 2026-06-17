import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@kmgeon/stepflow-core': resolve(root, '../stepflow-core/src/index.ts'),
      '@kmgeon/stepflow-test': resolve(root, '../stepflow-test/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
