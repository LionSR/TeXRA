import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Same alias/dedupe recipe as packages/desktop/vite.config.ts — the proven
// mechanism for running the real Progress View Lit components outside VS Code.
import { aliases } from '../../scripts/aliases.mjs';

// Builds straight into the extension's resources, so the CLI's existing
// `packages/extension/resources/**` staging step
// (packages/cli/scripts/copy-resources.mjs) picks it up without a separate
// build-then-copy script. This is the shared, multi-file bundle (external
// `assets/`) used by the shared-assets export mode (`--assets-dir`) — see
// vite.standalone.config.ts for the single-file, self-contained bundle used
// by the default export mode (resources/traceViewer).
const RESOURCES_OUT_DIR = resolve(
  import.meta.dirname,
  '../extension/resources/traceViewerShared',
);

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src'),
  build: {
    outDir: RESOURCES_OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    // Single large chunk is intentional for a static trace viewer served over
    // http(s). The standalone build shares this content but inlines everything
    // into a single HTML file via vite-plugin-singlefile (which sets its own
    // larger limit). Keep the warning suppressed here too so the reporter
    // output is clean across both configs.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/index.html'),
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
