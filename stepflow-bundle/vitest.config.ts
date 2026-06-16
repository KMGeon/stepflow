import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@stepflow/core': resolve(root, '../stepflow-core/src/index.ts'),
      '@stepflow/infrastructure': resolve(root, '../stepflow-infrastructure/src/index.ts'),
      '@stepflow/puppeteer': resolve(root, '../stepflow-puppeteer/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
