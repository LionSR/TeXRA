import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Same alias/dedupe recipe as vite.config.ts and packages/desktop/vite.config.ts.
import { aliases } from '../../scripts/aliases.mjs';

/**
 * A second build of the same `src/` entry as `vite.config.ts`, inlined into
 * one self-contained `index.html` (JS, CSS, and KaTeX fonts all as data URIs
 * — no `assets/` folder at all).
 *
 * Why this exists: a `<script type="module" src="./assets/...">` — the
 * default multi-file build's output — fails entirely under `file://`.
 * Chromium treats every `file://` resource as its own opaque origin, so a
 * module script's fetch of a sibling file is cross-origin and gets blocked
 * by CORS (confirmed empirically; `crossorigin` on the tag isn't the cause —
 * removing it doesn't help). `vite-plugin-singlefile` sidesteps this by
 * leaving no external file for the module to fetch. This build backs the
 * CLI's/extension's default self-contained export, which must open via
 * `file://` with no server running. The regular multi-file build
 * (`vite.config.ts` → resources/traceViewerShared) stays for the
 * shared-assets, site-hosting case, which is always served over http(s)
 * and never hits this restriction.
 */
const RESOURCES_OUT_DIR = resolve(
  import.meta.dirname,
  '../extension/resources/traceViewer',
);

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src'),
  plugins: [viteSingleFile()],
  build: {
    outDir: RESOURCES_OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
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
