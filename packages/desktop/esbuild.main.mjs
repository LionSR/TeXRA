import * as esbuild from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  tsconfig: 'tsconfig.main.json',
  target: 'node22',
  // ESM output has no CJS globals. Bundled CommonJS deps still reference them:
  //   - `require` (createRequire) — needed by several deps.
  //   - `__filename` — write-file-atomic's getTmpname() reads it; without this
  //     shim the app fatally crashes on startup ("__filename is not defined")
  //     in bootstrapPlatformAgentDirectories -> JsonStore.flush.
  // Do NOT also shim `__dirname` here: esbuild already emits a `var __dirname`
  // in the one chunk that needs it, so a banner `const __dirname` collides
  // ("Identifier '__dirname' has already been declared").
  banner: {
    js:
      `import { createRequire as __texraCreateRequire } from 'node:module';\n` +
      `import { fileURLToPath as __texraFileURLToPath } from 'node:url';\n` +
      `const require = __texraCreateRequire(import.meta.url);\n` +
      `const __filename = __texraFileURLToPath(import.meta.url);`,
  },
});

await mkdir(outdirPath, { recursive: true });
await writeFile(
  resolve(outdirPath, 'metafile.json'),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
);
