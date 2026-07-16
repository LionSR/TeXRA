import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

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
const {
  buildTexraPackageConfiguration,
} = require('../out/packages/extension/src/schemas/texraSettings.js');
const {
  packageCommandContributions,
  commandKeybindings,
} = require('../out/src/shared/commands/catalog.js');

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
