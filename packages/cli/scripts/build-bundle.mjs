#!/usr/bin/env node

import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

import { reactCompilerPlugin } from './reactCompilerPlugin.mjs';

const outfile = 'dist/bin/texra.js';

await build({
  entryPoints: ['src/bin/texra.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  outfile,
  // The React Compiler runs as a Babel pre-pass scoped to .tsx files under
  // packages/cli/src/chat/tui/. Confirmed addition is only
  // `react/compiler-runtime`; see docs/prd/cli-tui-ink/20-implementation.md
  // (Phase 0). Risk R12.
  plugins: [reactCompilerPlugin()],
  // JSX needs to be transformed for ink (which uses React's JSX runtime).
  jsx: 'automatic',
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __texraCreateRequire } from "node:module";\n' +
      'const require = __texraCreateRequire(import.meta.url);',
  },
});

await chmod(outfile, 0o755);
