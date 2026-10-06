import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

import { codeSandboxWorker } from '../../../scripts/code-sandbox-worker.mjs';
import { stubInternalValidationModel } from '../../../scripts/stub-internal-validation-model.mjs';

const packageRoot = new URL('..', import.meta.url);
const quickJsWasmSpecifier = '@jitl/quickjs-wasmfile-release-sync/wasm';

await build({
  absWorkingDir: fileURLToPath(packageRoot),
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    schemas: 'src/schemas.ts',
    plugins: 'src/plugins.ts',
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
    stubInternalValidationModel,
    codeSandboxWorker,
  ],
  loader: {
    '.wasm': 'binary',
  },
  sourcemap: false,
  splitting: true,
  target: 'es2022',
  tsconfig: '../../tsconfig.json',
});
