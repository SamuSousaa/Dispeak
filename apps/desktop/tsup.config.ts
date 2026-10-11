import { defineConfig } from 'tsup';

// Everything but Electron itself is bundled, so the installer ships no node_modules.
const shared = {
  clean: false,
  sourcemap: true,
  noExternal: [/^(?!electron$)/],
  external: ['electron'],
};

export default defineConfig([
  {
    ...shared,
    entry: { main: 'src/main.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
  },
  {
    ...shared,
    // A sandboxed preload script is CommonJS.
    entry: { 'picker-preload': 'src/picker/preload.ts' },
    format: ['cjs'],
    target: 'node22',
    platform: 'node',
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    ...shared,
    entry: { picker: 'src/picker/renderer.ts' },
    format: ['iife'],
    target: 'chrome140',
    platform: 'browser',
  },
]);
