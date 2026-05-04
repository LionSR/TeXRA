import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJson } from './extension-package-utils.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const desktopDir = path.join(rootDir, 'packages', 'desktop');

function relative(filePath) {
  return path.relative(rootDir, filePath);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function collectFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

const packageJson = readJson(path.join(desktopDir, 'package.json'));
const manifestMain = path.join(desktopDir, packageJson.main);
const requiredFiles = [
  manifestMain,
  path.join(desktopDir, 'dist', 'preload', 'index.cjs'),
  path.join(desktopDir, 'dist', 'renderer', 'index.html'),
];
const failures = [];
const vscodeRuntimeImportPattern =
  /\b(?:import\s*\(\s*['"]vscode['"]\s*\)|import\s+[^;]*\s+from\s+['"]vscode['"]|(?:__require|require|requireFn)(?:\?\.)?\(\s*['"]vscode['"]\s*\))/;
const vscodeBackedStateImportPattern =
  /^\s*(?:(?:import(?:\s+type)?(?:\s+[^;]*?\s+from)?)|(?:export(?:\s+type)?\s+[^;]*?\s+from))\s+['"]@common\/state(?:\/stateManager)?['"]/m;
const desktopSharedSourceDirs = [
  path.join(rootDir, 'packages', 'desktop', 'src'),
  path.join(rootDir, 'src', 'agent', 'implementations', 'flows', 'tooluse'),
  path.join(rootDir, 'src', 'agent', 'runtime'),
  path.join(rootDir, 'src', 'logger'),
  path.join(rootDir, 'src', 'model'),
  path.join(rootDir, 'src', 'shared'),
  path.join(rootDir, 'src', 'utils'),
];

for (const filePath of requiredFiles) {
  if (!fileExists(filePath)) {
    failures.push(`Missing desktop build artifact: ${relative(filePath)}`);
  }
}

const rendererAssetsDir = path.join(desktopDir, 'dist', 'renderer', 'assets');
const rendererAssets = fs.existsSync(rendererAssetsDir)
  ? collectFiles(rendererAssetsDir)
  : [];
if (!rendererAssets.some((filePath) => filePath.endsWith('.js'))) {
  failures.push('Desktop renderer build did not emit a JavaScript asset.');
}
if (!rendererAssets.some((filePath) => filePath.endsWith('.css'))) {
  failures.push('Desktop renderer build did not emit a CSS asset.');
}
if (
  fileExists(manifestMain) &&
  vscodeRuntimeImportPattern.test(fs.readFileSync(manifestMain, 'utf8'))
) {
  failures.push(
    'Desktop main bundle contains a runtime import of the VS Code extension host module.',
  );
}

for (const dir of desktopSharedSourceDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const filePath of collectFiles(dir)) {
    if (!/\.[cm]?tsx?$/.test(filePath)) continue;
    if (!vscodeBackedStateImportPattern.test(fs.readFileSync(filePath, 'utf8')))
      continue;
    failures.push(
      `Desktop-shared source imports the VS Code-backed state barrel instead of @common/state/stateKeys: ${relative(
        filePath,
      )}`,
    );
  }
}

if (failures.length > 0) {
  console.error('Desktop build artifact check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const artifactList = [
  ...requiredFiles,
  ...rendererAssets.filter(
    (filePath) => filePath.endsWith('.js') || filePath.endsWith('.css'),
  ),
].map(relative);

console.log('Desktop build artifact check passed:');
for (const artifact of artifactList) console.log(`- ${artifact}`);
