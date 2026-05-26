#!/usr/bin/env node
// Bundles scripts/tui-harness.tsx into dist/bin/tui-harness.js for PTY tests.
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { reactCompilerPlugin } from './reactCompilerPlugin.mjs';

const reactDevtoolsStub = fileURLToPath(
  new URL('./react-devtools-core-stub.mjs', import.meta.url),
);

const outfile = 'dist/bin/tui-harness.js';

await build({
  entryPoints: ['scripts/tui-harness.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  alias: { 'react-devtools-core': reactDevtoolsStub },
  outfile,
  banner: {
    js: `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);`,
  },
  plugins: [reactCompilerPlugin()],
  logLevel: 'info',
});

await chmod(outfile, 0o755);
