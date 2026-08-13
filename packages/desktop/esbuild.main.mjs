import * as esbuild from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MAIN_OUTDIR_PATH, mainBuildOptions } from './esbuild.main.options.mjs';

await rm(MAIN_OUTDIR_PATH, { force: true, recursive: true });

const result = await esbuild.build(mainBuildOptions);

await mkdir(MAIN_OUTDIR_PATH, { recursive: true });
await writeFile(
  resolve(MAIN_OUTDIR_PATH, 'metafile.json'),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
);
