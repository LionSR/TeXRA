import { spawnSync } from 'node:child_process';
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
