#!/usr/bin/env node
// Phase 0 React Compiler smoke per
// docs/prd/cli-tui-ink/20-implementation.md#phase-0:
//
//   "Validate output by smoke-running a hello-world <App> and confirming
//    `react/compiler-runtime` is the only added import."
//
// Runs the same Babel pre-pass plugin against `src/chat/tui/App.tsx` and
// inspects the result. Fails the build if the pipeline regresses (e.g., the
// plugin chain throws on TSX, the compiler stops emitting its runtime import,
// or extra imports leak in).
//
// Wired into `pnpm run build` so the smoke can never silently rot.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { reactCompilerPlugin } from './reactCompilerPlugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeFile = resolve(here, '../src/chat/tui/App.tsx');

const recorded = {
  contents: undefined,
};

const fakeBuildApi = {
  onLoad(_filter, handler) {
    fakeBuildApi._handler = handler;
  },
};

const plugin = reactCompilerPlugin();
plugin.setup(fakeBuildApi);

if (typeof fakeBuildApi._handler !== 'function') {
  console.error('react-compiler smoke: plugin did not register onLoad hook');
  process.exit(1);
}

const args = { path: smokeFile, namespace: 'file' };
const result = await fakeBuildApi._handler(args);
if (!result || typeof result.contents !== 'string') {
  console.error(
    `react-compiler smoke: plugin returned no transformed contents for ${smokeFile}`,
  );
  process.exit(1);
}
recorded.contents = result.contents;

if (!recorded.contents.includes('react/compiler-runtime')) {
  console.error(
    'react-compiler smoke: expected the compiler to import `react/compiler-runtime` (was the compiler skipped?)',
  );
  console.error('---transformed output snippet---');
  console.error(recorded.contents.slice(0, 800));
  process.exit(1);
}

// Reject any unexpected `import ... from "<not whitelisted>"` additions.
// We compare the transformed module's bare imports against the source's
// bare imports plus a small allow-list. (Re-imports of the same module
// under different specifiers are fine.)
const source = await readFile(smokeFile, 'utf8');
const importRe = /import[^'"`]+['"`]([^'"`]+)['"`]/g;

function collectBareImports(code) {
  const imports = new Set();
  let match;
  while ((match = importRe.exec(code)) != null) {
    imports.add(match[1]);
  }
  return imports;
}

const sourceImports = collectBareImports(source);
const outputImports = collectBareImports(recorded.contents);

const ALLOWLIST = new Set([
  // The compiler adds its runtime.
  'react/compiler-runtime',
  // `@babel/preset-react` (automatic runtime) adds the JSX runtime imports.
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);

const unexpected = [...outputImports].filter(
  (name) => !sourceImports.has(name) && !ALLOWLIST.has(name),
);

if (unexpected.length > 0) {
  console.error(
    `react-compiler smoke: unexpected import(s) added by the plugin: ${unexpected.join(
      ', ',
    )}`,
  );
  process.exit(1);
}

console.log('react-compiler smoke: ok');
