import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Shared aliases keep desktop renderer imports aligned with extension webviews.
import { aliases } from '../../scripts/aliases.mjs';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/renderer'),
  // These entry points are loaded together by the shared Monaco loader.
  // Discovering them only after Electron starts invalidates the optimizer's
  // common chunks and forces a reload while the renderer is bootstrapping.
  optimizeDeps: {
    include: [
      'monaco-editor/editor/editor.api.js',
      'monaco-editor/features/register.all.js',
      'monaco-editor/languages/register.all.js',
      'monaco-editor/languages/features/register.all.js',
    ],
  },
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
      '@lit-labs/signals',
      'lit',
      'signal-polyfill',
    ],
  },
});
