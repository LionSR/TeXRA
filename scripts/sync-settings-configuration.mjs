import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packagePath = path.join(rootDir, 'packages', 'extension', 'package.json');
const require = createRequire(import.meta.url);
const {
  buildTexraPackageConfiguration,
} = require('../out/packages/extension/src/schemas/texraSettings.js');

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
  },
};
const nextPackageText = `${JSON.stringify(nextPackageJson, null, 2)}\n`;

if (check) {
  if (
    normalizeLineEndings(nextPackageText) !== normalizeLineEndings(packageText)
  ) {
    throw new Error(
      'packages/extension/package.json contributes.configuration is out of sync with TexraSettingsSchema. Run npm run sync:settings-configuration.',
    );
  }
  console.log('package.json settings configuration is in sync');
} else {
  await writeFile(packagePath, nextPackageText);
  console.log('Synced package.json settings configuration');
}
