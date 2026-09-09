import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const packageRoot = new URL('..', import.meta.url);
const quickJsWasmSpecifier = '@jitl/quickjs-wasmfile-release-sync/wasm';

await build({
  absWorkingDir: fileURLToPath(packageRoot),
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    effect: 'src/effect.ts',
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
      // `bibtex` is UMD/CommonJS whose named exports Node's ESM loader cannot
      // detect, so leaving it external makes every entry of the installed
      // package fail at module init with "does not provide an export named
      // parseBibFile" (found by `example/`, which installs the tarball as a
      // consumer does). It cannot be fixed at the import site: the source
      // must keep the named import, because its UMD exports carry
      // `__esModule: true` and a default import bundles to `undefined` under
      // esbuild's ESM interop (the 0.39.10 startup crash). Inlining it lets
      // esbuild resolve the binding at bundle time, exactly as the extension
      // and CLI bundles already do.
      name: 'bundle-cjs-bibtex',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^bibtex$/ }, ({ path }) => ({
          path: fileURLToPath(import.meta.resolve(path)),
          external: false,
        }));
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
