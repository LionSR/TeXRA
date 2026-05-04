import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const desktopDir = path.join(rootDir, 'packages', 'desktop');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

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
  return files;
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
