import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readJson,
  reportCheckFailures,
  requiredMonacoWorkers,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';
import { walkFiles } from './walkFiles.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const desktopDir = path.join(rootDir, 'packages', 'desktop');

function relative(filePath) {
  return path.relative(rootDir, filePath);
}

function fileExists(filePath) {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

function collectFiles(dir) {
  return walkFiles(dir)
    .map((entry) => entry.absolutePath)
    .sort();
}

const packageJson = readJson(path.join(desktopDir, 'package.json'));
const manifestMain = path.join(desktopDir, packageJson.main);
const requiredFiles = [
  manifestMain,
  path.join(desktopDir, 'dist', 'preload', 'index.cjs'),
  path.join(desktopDir, 'dist', 'renderer', 'index.html'),
];
const failures = [];

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
for (const workerName of requiredMonacoWorkers) {
  if (
    !rendererAssets.some((filePath) =>
      path.basename(filePath).includes(workerName),
    )
  ) {
    failures.push(
      `Desktop renderer build did not emit Monaco worker asset: ${workerName}`,
    );
  }
}
if (
  fileExists(manifestMain) &&
  vscodeRuntimeImportPattern.test(fs.readFileSync(manifestMain, 'utf8'))
) {
  failures.push(
    'Desktop main bundle contains a runtime import of the VS Code extension host module.',
  );
}

reportCheckFailures('Desktop build artifact check', failures);

const artifactList = [
  ...requiredFiles,
  ...rendererAssets.filter(
    (filePath) => filePath.endsWith('.js') || filePath.endsWith('.css'),
  ),
].map(relative);

console.log('Desktop build artifact check passed:');
for (const artifact of artifactList) console.log(`- ${artifact}`);
console.log('- Monaco worker assets are present');
