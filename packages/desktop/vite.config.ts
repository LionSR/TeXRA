import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Shared aliases keep desktop renderer imports aligned with extension webviews.
import { aliases } from '../../scripts/aliases.mjs';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/renderer'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/renderer/index.html'),
    },
  },
  resolve: {
    alias: aliases,
    dedupe: [
      '@awesome.me/webawesome',
      '@lit/context',
      '@lit-labs/signals',
      'lit',
      'signal-polyfill',
    ],
  },
});
