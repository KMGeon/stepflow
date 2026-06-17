import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  // Re-export from the constituent packages at runtime; never bundle them or the
  // optional browser/DB peers.
  external: [
    '@kmgeon/stepflow-core',
    '@kmgeon/stepflow-infrastructure',
    '@kmgeon/stepflow-puppeteer',
    'puppeteer',
    'mysql2',
    'better-sqlite3',
  ],
});
