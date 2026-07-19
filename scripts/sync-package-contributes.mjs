import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

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
let texraSettings;
let commandCatalog;
try {
  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      texraSettings: 'packages/extension/src/schemas/texraSettings.ts',
      commandCatalog: 'src/shared/commands/catalog.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: bundleDir,
    tsconfig: 'tsconfig.json',
  });
  texraSettings = require(path.join(bundleDir, 'texraSettings.js'));
  commandCatalog = require(path.join(bundleDir, 'commandCatalog.js'));
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
const { buildTexraPackageConfiguration } = texraSettings;
const { packageCommandContributions, commandKeybindings } = commandCatalog;

function getConfigurationSections(packageJson) {
  const configuration = packageJson.contributes?.configuration;
  if (!Array.isArray(configuration)) {
    throw new Error('package.json contributes.configuration must be an array');
  }
  return configuration;
}

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const check = process.argv.includes('--check');
const packageText = await readFile(packagePath, 'utf8');
const packageJson = JSON.parse(packageText);
// Spread preserves each key's existing position in `contributes`; only the
// three catalog-derived values are regenerated in place.
const nextPackageJson = {
  ...packageJson,
  contributes: {
    ...packageJson.contributes,
    configuration: buildTexraPackageConfiguration(
      getConfigurationSections(packageJson),
    ),
    commands: packageCommandContributions,
    keybindings: commandKeybindings,
  },
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
