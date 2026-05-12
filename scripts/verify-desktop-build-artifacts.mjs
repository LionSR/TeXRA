import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  getDesktopSharedSourceDirs,
  getDesktopVscodeFreeSourceDirs,
  readJson,
  requiredMonacoWorkers,
  vscodeBackedStateImportPattern,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';

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
const desktopSharedSourceDirs = getDesktopSharedSourceDirs(rootDir);
const desktopVscodeFreeSourceDirs = getDesktopVscodeFreeSourceDirs(rootDir);
const desktopSharedSourceDirSet = new Set(desktopSharedSourceDirs);
const desktopVscodeFreeSourceDirSet = new Set(desktopVscodeFreeSourceDirs);
const desktopSourceBoundaryDirs = [
  ...new Set([...desktopSharedSourceDirs, ...desktopVscodeFreeSourceDirs]),
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

for (const dir of desktopSourceBoundaryDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const filePath of collectFiles(dir)) {
    if (!/\.[cm]?tsx?$/.test(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    if (
      desktopSharedSourceDirSet.has(dir) &&
      vscodeBackedStateImportPattern.test(source)
    ) {
      failures.push(
        `Desktop-shared source imports the VS Code-backed state barrel instead of @common/state/stateKeys: ${relative(
          filePath,
        )}`,
      );
    }
    if (
      desktopVscodeFreeSourceDirSet.has(dir) &&
      vscodeRuntimeImportPattern.test(source)
    ) {
      failures.push(
        `Desktop-shared source imports the VS Code runtime module: ${relative(
          filePath,
        )}`,
      );
    }
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
console.log('- desktop-shared source avoids VS Code runtime imports');
console.log('- Monaco worker assets are present');
