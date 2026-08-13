import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const packageRoot = new URL('..', import.meta.url);
const quickJsWasmSpecifier = '@jitl/quickjs-wasmfile-release-sync/wasm';

await build({
  absWorkingDir: fileURLToPath(packageRoot),
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    schemas: 'src/schemas.ts',
    node: 'src/node.ts',
  },
  format: 'esm',
  logLevel: 'info',
  outdir: 'dist',
  packages: 'external',
  platform: 'neutral',
  plugins: [
    {
      // The repository patches OpenAI's response accumulator for provider
      // metadata events. Consumers do not inherit pnpm patches, so the package
      // must carry the tested realization instead of loading vanilla OpenAI.
      name: 'bundle-patched-openai',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^openai(?:\/|$)/ }, ({ path }) => ({
          path: fileURLToPath(import.meta.resolve(path)),
          external: false,
        }));
      },
    },
    {
      name: 'external-node-jsonrpc',
      setup(buildContext) {
        buildContext.onResolve(
          { filter: /^vscode-jsonrpc\/node$/ },
          ({ path }) => ({ path, external: true }),
        );
      },
    },
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
  ],
  loader: {
    '.wasm': 'binary',
  },
  sourcemap: false,
  splitting: true,
  target: 'es2022',
  tsconfig: '../../tsconfig.json',
});
