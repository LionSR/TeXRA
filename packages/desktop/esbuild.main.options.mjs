// Shared esbuild build options for the Electron main bundle.
//
// Both the one-shot build (`esbuild.main.mjs`) and the dev watcher
// (`esbuild.main.watch.mjs`) consume this so their bundle configuration can
// never drift apart.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esmCjsGlobalsBanner } from '../../scripts/esm-cjs-globals-banner.mjs';

const packageDir = dirname(fileURLToPath(import.meta.url));

export const MAIN_OUTDIR = 'dist/main';
export const MAIN_OUTDIR_PATH = resolve(packageDir, MAIN_OUTDIR);

/** esbuild options shared by the one-shot build and the dev watcher. */
export const mainBuildOptions = {
  absWorkingDir: packageDir,
  entryPoints: { index: 'src/main/bootstrap.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  splitting: true,
  metafile: true,
  outdir: MAIN_OUTDIR,
  chunkNames: 'chunks/[name]-[hash]',
  // node-pty is a native addon: it resolves its own .node binary relative to
  // its package directory at runtime, which breaks once the JS is inlined into
  // a bundle chunk. Keep it external so the require resolves to the real
  // installed package (electron-builder ships it via node_modules).
  external: ['electron', 'fsevents', 'node-pty'],
  loader: { '.wasm': 'binary' },
  tsconfig: 'tsconfig.main.json',
  target: 'node22',
  banner: { js: esmCjsGlobalsBanner },
};
