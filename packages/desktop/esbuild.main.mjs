import * as esbuild from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esmCjsGlobalsBanner } from '../../scripts/esm-cjs-globals-banner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = 'dist/main';
const outdirPath = resolve(__dirname, outdir);

await rm(outdirPath, { force: true, recursive: true });

const result = await esbuild.build({
  absWorkingDir: __dirname,
  entryPoints: { index: 'src/main/bootstrap.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  splitting: true,
  metafile: true,
  outdir,
  chunkNames: 'chunks/[name]-[hash]',
  external: ['electron', 'fsevents'],
  loader: { '.wasm': 'binary' },
  tsconfig: 'tsconfig.main.json',
  target: 'node22',
  banner: { js: esmCjsGlobalsBanner },
});

await mkdir(outdirPath, { recursive: true });
await writeFile(
  resolve(outdirPath, 'metafile.json'),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
);
