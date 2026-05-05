import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [resolve(__dirname, 'src/main/bootstrap.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(__dirname, 'dist/main/index.js'),
  external: ['electron', 'fsevents'],
  tsconfig: resolve(__dirname, 'tsconfig.main.json'),
  target: 'node22',
  banner: {
    js:
      `import { createRequire as __texraCreateRequire } from 'node:module';\n` +
      `const require = __texraCreateRequire(import.meta.url);`,
  },
});
