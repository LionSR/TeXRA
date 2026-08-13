#!/usr/bin/env node
// Bundles scripts/tui-harness.tsx into dist/bin/tui-harness.js for PTY tests.
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const reactDevtoolsStub = fileURLToPath(
  new URL('./react-devtools-core-stub.mjs', import.meta.url),
);

const outfile = 'dist/bin/tui-harness.js';

try {
  const [{ build }, { reactCompilerPlugin }, { esmCjsGlobalsBanner }] =
    await Promise.all([
      import('esbuild'),
      import('./reactCompilerPlugin.mjs'),
      import('../../../scripts/esm-cjs-globals-banner.mjs'),
    ]);

  await build({
    entryPoints: ['scripts/tui-harness.tsx'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // See build-bundle.mjs: clipboardy resolves its fallback binaries
    // relative to `import.meta.url`, which esbuild bundling breaks.
    external: ['fsevents', 'clipboardy'],
    jsx: 'automatic',
    // Keep the harness build graph faithful to the production CLI bundle.
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.wasm': 'binary' },
    alias: { 'react-devtools-core': reactDevtoolsStub },
    outfile,
    banner: {
      js: esmCjsGlobalsBanner,
    },
    plugins: [reactCompilerPlugin()],
    logLevel: 'info',
  });

  await chmod(outfile, 0o755);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[build-harness] failed to build TUI harness.');
  console.error(
    '[build-harness] If dependencies are missing, run `corepack pnpm install` from the repo root.',
  );
  console.error(`[build-harness] ${message}`);
  process.exit(1);
}
