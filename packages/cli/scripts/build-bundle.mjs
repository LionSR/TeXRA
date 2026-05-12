#!/usr/bin/env node

import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

const outfile = 'dist/bin/texra.js';

await build({
  entryPoints: ['src/bin/texra.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  outfile,
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __texraCreateRequire } from "node:module";\n' +
      'const require = __texraCreateRequire(import.meta.url);',
  },
});

await chmod(outfile, 0o755);
