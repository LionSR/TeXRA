import * as esbuild from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, 'dist/main');

await rm(outdir, { force: true, recursive: true });

await esbuild.build({
  entryPoints: { index: resolve(__dirname, 'src/main/bootstrap.ts') },
  bundle: true,
  platform: 'node',
  format: 'esm',
  splitting: true,
  outdir,
  chunkNames: 'chunks/[name]-[hash]',
  external: ['electron', 'fsevents'],
  tsconfig: resolve(__dirname, 'tsconfig.main.json'),
  target: 'node22',
  banner: {
    js:
      `import { createRequire as __texraCreateRequire } from 'node:module';\n` +
      `const require = __texraCreateRequire(import.meta.url);`,
  },
});
