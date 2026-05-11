#!/usr/bin/env node

import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin/texra.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  outfile: 'dist/bin/texra.js',
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __texraCreateRequire } from "node:module";\n' +
      'const require = __texraCreateRequire(import.meta.url);',
  },
});
