import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'puppeteer/index': 'src/puppeteer/index.ts',
    'infrastructure/index': 'src/infrastructure/index.ts',
    'integration/index': 'src/integration/index.ts',
    'test/index': 'src/test/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  // Subpath entries reference the core entry via the package's own name
  // (e.g. `@kmgeon/stepflow`); keep those self-references and the optional
  // runtime peers out of every bundle so the core engine ships exactly once.
  external: [/^@kmgeon\/stepflow/, 'puppeteer', 'mysql2', 'better-sqlite3', 'vitest'],
});
