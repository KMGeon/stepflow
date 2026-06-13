import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Barrel/entry and type-only modules have no executable code.
      exclude: ['src/index.ts', 'src/job-repository.ts', 'src/metadata.ts'],
    },
  },
});
