import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

// Resolve the package's own subpath imports to source during tests so we never
// run against a stale dist build. Order matters: subpaths before the bare name.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@kmgeon/stepflow/puppeteer', replacement: resolve(root, 'src/puppeteer/index.ts') },
      {
        find: '@kmgeon/stepflow/infrastructure',
        replacement: resolve(root, 'src/infrastructure/index.ts'),
      },
      {
        find: '@kmgeon/stepflow/integration',
        replacement: resolve(root, 'src/integration/index.ts'),
      },
      { find: '@kmgeon/stepflow/test', replacement: resolve(root, 'src/test/index.ts') },
      { find: /^@kmgeon\/stepflow$/, replacement: resolve(root, 'src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
