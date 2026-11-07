// Electron main bundle. `--watch` is the dev loop (scripts/dev.mjs): it
// rebuilds on edits under src/main/ and repo-root src/ and leaves the outdir
// in place, since Electron may be holding those files open. The main process
// cannot hot-reload, so each rebuild prints a line saying to restart Electron.
import * as esbuild from 'esbuild';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessBundleOptions } from '../../scripts/code-sandbox-worker.mjs';
import { esmCjsGlobalsBanner } from '../../scripts/esm-cjs-globals-banner.mjs';

const packageDir = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(packageDir, 'dist/main');
const watch = process.argv.includes('--watch');

const writeMetafile = (metafile) =>
  writeFile(
    resolve(outdir, 'metafile.json'),
    `${JSON.stringify(metafile, null, 2)}\n`,
  );

/** Reports each watch rebuild so the operator knows to restart Electron. */
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
      await writeMetafile(result.metafile);
      console.log(
        first
          ? `[main:watch ${stamp}] initial build OK — watching src/main and repo-root src`
          : `[main:watch ${stamp}] rebuilt OK — restart Electron to pick it up`,
      );
      first = false;
    });
  },
};

const base = harnessBundleOptions();
const options = {
  ...base,
  absWorkingDir: packageDir,
  entryPoints: { index: 'src/main/bootstrap.ts' },
  platform: 'node',
  format: 'esm',
  splitting: true,
  metafile: true,
  outdir,
  chunkNames: 'chunks/[name]-[hash]',
  // node-pty is a native addon: it resolves its own .node binary relative to
  // its package directory at runtime, which breaks once the JS is inlined into
  // a bundle chunk. Keep it external so the require resolves to the real
  // installed package (electron-builder ships it via node_modules).
  external: ['electron', 'fsevents', 'node-pty'],
  loader: { ...base.loader, '.tex': 'text' },
  tsconfig: 'tsconfig.main.json',
  // The Node of the Electron that runs this bundle: 24.22 at the `electron`
  // floor, 45.2.3. The installed package records its ABI, not its Node
  // version, so an `electron` bump updates this by hand.
  target: 'node24.22',
  banner: { js: esmCjsGlobalsBanner },
};

if (watch) {
  const context = await esbuild.context({
    ...options,
    plugins: [...options.plugins, reportRebuild],
  });
  await context.watch();
} else {
  await rm(outdir, { force: true, recursive: true });
  const result = await esbuild.build(options);
  await writeMetafile(result.metafile);
}
