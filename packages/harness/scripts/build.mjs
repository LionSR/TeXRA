import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Run one Node entry point in the package root; a failed step ends the build. */
const runNode = (args) => {
  const { status } = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (status !== 0) process.exit(status ?? 1);
};
const runNodeScript = (script) => runNode([`scripts/${script}`]);

runNodeScript('clean.mjs');
runNodeScript('bundle.mjs');
// The package's sources are TypeScript the repository type-checks as one
// program, so the manifest declares no module type; the built output is
// ESM, and this scope marker says so to Node and to TypeScript for every
// file under dist/ (the bundles and their declarations).
writeFileSync(
  join(packageRoot, 'dist', 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
);
// The `tsc` bin's JavaScript entry (the package's own `bin` field), not the
// bin shim, so Windows needs no shell. The package exports no `bin/` path, so
// it is reached from its package.json.
const nativeTypeScript = dirname(
  createRequire(import.meta.url).resolve('@typescript/native/package.json'),
);
runNode([
  join(nativeTypeScript, 'bin', 'tsc'),
  '-p',
  '../../tsconfig.build.json',
]);
runNodeScript('rewrite-declaration-aliases.mjs');
runNodeScript('validate-artifacts.mjs');
