import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // The shared package ships TypeScript sources, so it has to be bundled.
  noExternal: [/^@frequencia\//],
});
