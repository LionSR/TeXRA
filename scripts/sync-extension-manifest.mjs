import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// Regenerates the catalog-derived parts of packages/extension/package.json:
// - contributes.configuration from TexraSettingsSchema (packages/extension/src/schemas/texraSettings.ts)
// - contributes.commands / contributes.keybindings from the shared command
//   catalog (src/shared/commands/catalog.ts)
//
// Run `npm run compile:tsc-out` first so the modules below exist as compiled
// JS under out/ (plain Node here does not have tsconfig path-alias / ts-node
// support). `npm run sync:extension-manifest` / `check:extension-manifest`
// do this for you.
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
  buildCommandManifestEntries,
  commandKeybindings,
} = require('../out/src/shared/commands/catalog.js');

function parseArgs() {
  return {
    check: process.argv.includes('--check'),
  };
}

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

const { check } = parseArgs();
const packageText = await readFile(packagePath, 'utf8');
const packageJson = JSON.parse(packageText);
const nextPackageJson = {
  ...packageJson,
  contributes: {
    ...packageJson.contributes,
    configuration: buildTexraPackageConfiguration(
      getConfigurationSections(packageJson),
    ),
    commands: buildCommandManifestEntries(),
    keybindings: commandKeybindings,
  },
};
const nextPackageText = `${JSON.stringify(nextPackageJson, null, 2)}\n`;

if (check) {
  if (
    normalizeLineEndings(nextPackageText) !== normalizeLineEndings(packageText)
  ) {
    throw new Error(
      'packages/extension/package.json contributes.configuration/commands/keybindings are out of sync with the settings + command catalogs. Run npm run sync:extension-manifest.',
    );
  }
  console.log(
    'package.json manifest (configuration/commands/keybindings) is in sync',
  );
} else {
  await writeFile(packagePath, nextPackageText);
  console.log(
    'Synced package.json manifest (configuration/commands/keybindings)',
  );
}
