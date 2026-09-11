import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Same alias/dedupe recipe as packages/desktop/vite.config.ts — the proven
// mechanism for running the real Progress View Lit components outside VS Code.
import { aliases } from '../../scripts/aliases.mjs';

/**
 * Builds the trace viewer straight into the extension's resources (so the
 * CLI's `packages/extension/resources/**` staging step,
 * packages/cli/scripts/copy-resources.mjs, picks it up) as one self-contained
 * `index.html`: JS, CSS, and KaTeX fonts all inlined as data URIs, no
 * `assets/` folder at all.
 *
 * Why single-file: a `<script type="module" src="./assets/...">` fails
 * entirely under `file://`. Chromium treats every `file://` resource as its
 * own opaque origin, so a module script's fetch of a sibling file is
 * cross-origin and gets blocked by CORS (confirmed empirically; `crossorigin`
 * on the tag isn't the cause — removing it doesn't help).
 * `vite-plugin-singlefile` leaves no external file for the module to fetch,
 * so the default export opens via `file://` with no server running. The same
 * page, left un-injected, serves the CLI's `--assets-dir` site-hosting mode
 * over http(s) by fetching its `?trace=` file.
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
      '@lit-labs/signals',
      'lit',
      'signal-polyfill',
    ],
  },
});
