// Dev-only watcher for the Electron main bundle.
//
// Mirrors `esbuild.main.mjs` exactly, but uses esbuild's watch mode instead of
// a one-shot build, so edits under `src/main/` (and anything it imports from
// repo-root `src/`) rebuild automatically. It deliberately does NOT clear the
// outdir on every rebuild (the one-shot script does) — Electron may be holding
// those files open.
//
// The renderer hot-reloads through Vite (`ELECTRON_RENDERER_URL`); the main
// process cannot, so a rebuild here still needs an Electron restart. Each
// rebuild prints a line so you know when to restart.
//
// Usage:  node esbuild.main.watch.mjs
import * as esbuild from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MAIN_OUTDIR_PATH, mainBuildOptions } from './esbuild.main.options.mjs';

await mkdir(MAIN_OUTDIR_PATH, { recursive: true });

/** Reports each rebuild so the operator knows to restart Electron. */
const reportRebuild = {
  name: 'report-rebuild',
  setup(build) {
    let first = true;
    build.onEnd(async (result) => {
      const stamp = new Date().toTimeString().slice(0, 8);
      if (result.errors.length > 0) {
        console.error(
          `[main:watch ${stamp}] FAILED (${result.errors.length} errors)`,
        );
        return;
      }
      if (result.metafile) {
        await writeFile(
          resolve(MAIN_OUTDIR_PATH, 'metafile.json'),
          `${JSON.stringify(result.metafile, null, 2)}\n`,
        );
      }
      console.log(
        first
          ? `[main:watch ${stamp}] initial build OK — watching src/main and repo-root src`
          : `[main:watch ${stamp}] rebuilt OK — restart Electron to pick it up`,
      );
      first = false;
    });
  },
};

const context = await esbuild.context({
  ...mainBuildOptions,
  plugins: [reportRebuild],
});

await context.watch();
