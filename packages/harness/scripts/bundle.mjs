import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { harnessBundleOptions } from '../../../scripts/code-sandbox-worker.mjs';

const packageRoot = new URL('..', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('package.json', packageRoot), 'utf8'),
);
// One bundle per published entry, named as its `import` file and built from
// the source its declaration comes from.
const entryPoints = Object.fromEntries(
  Object.values(manifest.publishConfig.exports)
    .filter((target) => typeof target !== 'string')
    .map(({ import: built, types }) => [
      built.replace(/^\.\/dist\//, '').replace(/\.js$/, ''),
      types.replace(/^\.\/dist\/types\//, 'src/').replace(/\.d\.ts$/, '.ts'),
    ]),
);
const quickJsWasmSpecifier = '@jitl/quickjs-wasmfile-release-sync/wasm';
const base = harnessBundleOptions();

await build({
  ...base,
  absWorkingDir: fileURLToPath(packageRoot),
  entryPoints,
  format: 'esm',
  logLevel: 'info',
  outdir: 'dist',
  packages: 'external',
  platform: 'neutral',
  plugins: [
    {
      name: 'quickjs-wasm',
      setup(buildContext) {
        buildContext.onResolve(
          { filter: /^@jitl\/quickjs-wasmfile-release-sync\/wasm$/ },
          () => ({
            path: fileURLToPath(import.meta.resolve(quickJsWasmSpecifier)),
          }),
        );
      },
    },
    ...base.plugins,
  ],
  sourcemap: false,
  splitting: true,
  target: 'es2022',
  tsconfig: '../../tsconfig.json',
});
