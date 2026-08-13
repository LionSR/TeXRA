#!/usr/bin/env node
// Phase 0 React Compiler smoke per
// docs/prds/cli-tui-ink/2026-05-14-20-implementation.md#phase-0:
//
//   "Validate output by smoke-running a hello-world <App> and confirming
//    `react/compiler-runtime` is the only added import."
//
// Runs the same Babel pre-pass plugin against one file from each directory
// the plugin scopes to (`src/chat/tui/App.tsx` and the shared Ink UI kit's
// `src/tui/ui/Select.tsx`) and inspects the result. Fails the build if the
// pipeline regresses (e.g., the plugin chain throws on TSX, the compiler
// stops emitting its runtime import, extra imports leak in, or one of the
// two directories silently drops out of the plugin's path matcher).
//
// Wired into `pnpm run build` so the smoke can never silently rot.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { reactCompilerPlugin } from './reactCompilerPlugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeFiles = [
  resolve(here, '../src/chat/tui/App.tsx'),
  resolve(here, '../src/tui/ui/Select.tsx'),
];

let loadHandler;
const fakeBuildApi = {
  onLoad(_filter, handler) {
    loadHandler = handler;
  },
};

const plugin = reactCompilerPlugin();
plugin.setup(fakeBuildApi);

if (typeof loadHandler !== 'function') {
  console.error('react-compiler smoke: plugin did not register onLoad hook');
  process.exit(1);
}

// Reject any unexpected `import ... from "<not whitelisted>"` additions.
// We compare the transformed module's bare imports against the source's
// bare imports plus a small allow-list. (Re-imports of the same module
// under different specifiers are fine.)
function collectBareImports(code) {
  // Fresh regex per call — a module-scoped `g`-flag regex is stateful via
  // `lastIndex` and would leak between calls if either loop exited early.
  const importRe = /import[^'"`]+['"`]([^'"`]+)['"`]/g;
  const imports = new Set();
  for (const match of code.matchAll(importRe)) {
    imports.add(match[1]);
  }
  return imports;
}

const ALLOWLIST = new Set([
  // The compiler adds its runtime.
  'react/compiler-runtime',
  // `@babel/preset-react` (automatic runtime) adds the JSX runtime imports.
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);

for (const smokeFile of smokeFiles) {
  const args = { path: smokeFile, namespace: 'file' };
  const result = await loadHandler(args);
  if (!result || typeof result.contents !== 'string') {
    console.error(
      `react-compiler smoke: plugin returned no transformed contents for ${smokeFile}`,
    );
    process.exit(1);
  }
  const contents = result.contents;

  if (!contents.includes('react/compiler-runtime')) {
    console.error(
      `react-compiler smoke: expected the compiler to import \`react/compiler-runtime\` for ${smokeFile} (was the compiler skipped?)`,
    );
    console.error('---transformed output snippet---');
    console.error(contents.slice(0, 800));
    process.exit(1);
  }

  const source = await readFile(smokeFile, 'utf8');
  const sourceImports = collectBareImports(source);
  const outputImports = collectBareImports(contents);

  const unexpected = [...outputImports].filter(
    (name) => !sourceImports.has(name) && !ALLOWLIST.has(name),
  );

  if (unexpected.length > 0) {
    console.error(
      `react-compiler smoke: unexpected import(s) added by the plugin for ${smokeFile}: ${unexpected.join(
        ', ',
      )}`,
    );
    process.exit(1);
  }
}

console.log('react-compiler smoke: ok');
