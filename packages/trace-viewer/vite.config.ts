import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Same alias/dedupe recipe as packages/desktop/vite.config.ts — the proven
// mechanism for running the real Progress View Lit components outside VS Code.
import { aliases } from '../../scripts/aliases.mjs';

// Builds straight into the extension's resources (mirrors the htmlExport
// assets convention — scripts/copy-html-export-assets.mjs), so the CLI's
// existing `packages/extension/resources/**` staging step
// (packages/cli/scripts/copy-resources.mjs) picks it up without a separate
// build-then-copy script.
const RESOURCES_OUT_DIR = resolve(
  __dirname,
  '../extension/resources/traceViewer',
);

export default defineConfig({
  base: './',
  root: resolve(__dirname, 'src'),
  build: {
    outDir: RESOURCES_OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'),
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
