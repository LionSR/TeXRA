// Node.js imports
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { build } from 'esbuild';

// Code-generate the catalog-derived parts of the VS Code manifest
// (`contributes.configuration`, `contributes.commands`,
// `contributes.keybindings`) from their single sources of truth so the
// manifest never has to be hand-edited. In `--check` mode this is the CI diff
// gate: it fails when the committed manifest drifts from the catalogs.

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packagePath = path.join(rootDir, 'packages', 'extension', 'package.json');
const require = createRequire(import.meta.url);
const bundleDir = await mkdtemp(
  path.join(tmpdir(), 'texra-package-contributes-'),
);
let commandCatalog;
try {
  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      commandCatalog: 'src/shared/commands/catalog.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outdir: bundleDir,
    tsconfig: 'tsconfig.json',
  });
  commandCatalog = require(path.join(bundleDir, 'commandCatalog.js'));
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
const { packageCommandContributions, commandKeybindings } = commandCatalog;

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const check = process.argv.includes('--check');
const packageText = await readFile(packagePath, 'utf8');
const packageJson = JSON.parse(packageText);
if (packageJson.contributes?.configuration !== undefined) {
  throw new Error(
    'packages/extension/package.json must not contribute TeXRA settings; use the native TeXRA settings view.',
  );
}
const contributes = {
  ...packageJson.contributes,
  commands: packageCommandContributions,
  keybindings: commandKeybindings,
};
const nextPackageJson = {
  ...packageJson,
  contributes,
};
const nextPackageText = `${JSON.stringify(nextPackageJson, null, 2)}\n`;

if (check) {
  if (
    normalizeLineEndings(nextPackageText) !== normalizeLineEndings(packageText)
  ) {
    throw new Error(
      'packages/extension/package.json contributes.* is out of sync with the settings/command catalogs. Run npm run sync:package-contributes.',
    );
  }
  console.log('package.json contributes.* is in sync with the catalogs');
} else {
  await writeFile(packagePath, nextPackageText);
  console.log('Synced package.json contributes.* from the catalogs');
}
