import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

import { harnessBundleOptions } from '../../../scripts/code-sandbox-worker.mjs';

const packageRoot = new URL('..', import.meta.url);
const quickJsWasmSpecifier = '@jitl/quickjs-wasmfile-release-sync/wasm';
const base = harnessBundleOptions();

await build({
  ...base,
  absWorkingDir: fileURLToPath(packageRoot),
  entryPoints: {
    index: 'src/index.ts',
    schemas: 'src/schemas.ts',
    transcript: 'src/transcriptEntry.ts',
    plugins: 'src/plugins.ts',
    host: 'src/host.ts',
    node: 'src/node.ts',
  },
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
