import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopPackageJsonPath = join(
  repoRoot,
  'packages',
  'desktop',
  'package.json',
);
const desktopRequire = createRequire(desktopPackageJsonPath);

function fail(...lines) {
  console.error('Desktop Electron binary check failed.');
  for (const line of lines) console.error(line);
  process.exit(1);
}

let electronBinaryPath;
try {
  electronBinaryPath = desktopRequire('electron');
} catch (error) {
  fail(
    'The electron package did not install its platform binary. Run `corepack pnpm install --frozen-lockfile` with the root pnpm build-script policy applied.',
    error instanceof Error ? error.message : String(error),
  );
}

if (typeof electronBinaryPath !== 'string' || electronBinaryPath.length === 0) {
  fail('The electron package did not resolve to a binary path.');
}

try {
  await access(electronBinaryPath);
} catch (error) {
  fail(
    `Resolved Electron binary does not exist: ${electronBinaryPath}`,
    error instanceof Error ? error.message : String(error),
  );
}

console.log(`Desktop Electron binary check passed: ${electronBinaryPath}`);
