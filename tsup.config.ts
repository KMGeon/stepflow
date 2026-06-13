import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mysql.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
});
