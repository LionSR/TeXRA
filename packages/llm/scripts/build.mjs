// The publishable build of `@texra-ai/llm`. In the workspace the package's
// `exports` are its TypeScript sources; `publishConfig.exports` swaps them
// for what this writes to dist/ when the package is packed: one ESM bundle
// per entry (each protocol a chunk that `bindModel`'s literal `import()`
// loads on demand), every bare dependency left external except OpenAI's,
// and the entries' declarations. The harness's artifact validator checks
// the result as it checks its own.
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Run one Node entry point in the package root; a failed step ends the build. */
const runNode = (args) => {
  const { status } = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (status !== 0) process.exit(status ?? 1);
};

await rm(join(packageRoot, 'dist'), { force: true, recursive: true });
await build({
  absWorkingDir: packageRoot,
  bundle: true,
  entryPoints: { index: 'src/index.ts', node: 'src/node.ts' },
  format: 'esm',
  logLevel: 'info',
  outdir: 'dist',
  packages: 'external',
  platform: 'neutral',
  plugins: [
    {
      // The repository patches OpenAI's response accumulator for provider
      // metadata events. Consumers do not inherit pnpm patches, so the
      // package carries the tested realization instead of vanilla OpenAI.
      name: 'bundle-patched-openai',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^openai(?:\/|$)/ }, ({ path }) => ({
          path: fileURLToPath(import.meta.resolve(path)),
          external: false,
        }));
      },
    },
  ],
  sourcemap: false,
  splitting: true,
  target: 'es2022',
});
// The `tsc` bin's JavaScript entry, so Windows needs no shell.
const typescript = dirname(
  createRequire(import.meta.url).resolve('@typescript/native/package.json'),
);
runNode([
  join(typescript, 'bin', 'tsc'),
  '-p',
  'tsconfig.json',
  '--noEmit',
  'false',
  '--declaration',
  '--emitDeclarationOnly',
  '--removeComments',
  '--rootDir',
  'src',
  '--outDir',
  'dist/types',
]);
runNode(['../harness/scripts/validate-artifacts.mjs', packageRoot]);
