import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  extensionManifestSnapshot,
  readJson,
} from './extension-package-utils.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const snapshotPath = path.join(
  rootDir,
  'scripts',
  'extension-package-invariants.snapshot.json',
);
const packagePath = findExtensionPackagePath();
const packageDir = path.dirname(packagePath);
const vscodeIgnorePath = path.join(packageDir, '.vscodeignore');

const MANIFEST_KEYS = [
  'name',
  'displayName',
  'description',
  'publisher',
  'engines',
  'categories',
  'activationEvents',
  'main',
  'capabilities',
  'contributes',
  'icon',
];

const REQUIRED_PACKAGED_PATHS = [
  'LICENSE.txt',
  'changelog.md',
  'readme.md',
  'resources/agents',
  'resources/docs/agent-creation',
  'resources/examples',
  'resources/logo-128x128.png',
  'resources/logo-128x128.svg',
  'resources/shared/latex_style_rules.txt',
  'resources/templates',
  'resources/tool_use_agents',
  'resources/walkthroughs',
  'src/common/styles/common.css',
  'src/progressView/index.html',
  'src/settingsView/index.html',
  'src/webview/index.html',
];

// Paths in REQUIRED_PACKAGED_PATHS produced by the build (copied from the
// repo root by scripts/copy-extension-docs.mjs). They do not need to exist
// in the source tree, but verify-vsix-contents.mjs still checks the built
// VSIX includes them.
const BUILD_TIME_PACKAGED_PATHS = new Set(['readme.md', 'changelog.md']);

const REQUIRED_VSCODEIGNORE_LINES = [
  'src/**',
  '!resources/**',
  '!src/common/styles/*.css',
  '!src/progressView/*.html',
  '!src/settingsView/*.html',
  '!src/webview/*.html',
];

function findExtensionPackagePath() {
  const splitPackagePath = path.join(
    rootDir,
    'packages',
    'extension',
    'package.json',
  );
  return fs.existsSync(splitPackagePath)
    ? splitPackagePath
    : path.join(rootDir, 'package.json');
}

function collectStringValues(value, results = []) {
  if (typeof value === 'string') {
    results.push(value);
    return results;
  }

  if (Array.isArray(value)) {
    for (const child of value) collectStringValues(child, results);
    return results;
  }

  if (value && typeof value === 'object') {
    for (const child of Object.values(value))
      collectStringValues(child, results);
  }

  return results;
}

function manifestAssetReferences(packageJson) {
  const manifest = extensionManifestSnapshot(packageJson, MANIFEST_KEYS);
  return [
    ...new Set(
      collectStringValues(manifest).filter(
        (value) =>
          value.startsWith('resources/') || value.startsWith('./resources/'),
      ),
    ),
  ].sort();
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function relativeExists(relativePath) {
  return fs.existsSync(path.join(packageDir, relativePath));
}

function hasFiles(relativeDir) {
  const absoluteDir = path.join(packageDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return false;
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relativeDir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(child)) return true;
  }
  return false;
}

function buildSnapshot() {
  const packageJson = readJson(packagePath);
  return {
    manifest: extensionManifestSnapshot(packageJson, MANIFEST_KEYS),
    manifestAssetReferences: manifestAssetReferences(packageJson),
    requiredPackagedPaths: REQUIRED_PACKAGED_PATHS,
    requiredVscodeIgnoreLines: REQUIRED_VSCODEIGNORE_LINES,
  };
}

function verifySnapshot(actualSnapshot, failures) {
  if (!fs.existsSync(snapshotPath)) {
    failures.push(
      'Missing scripts/extension-package-invariants.snapshot.json. Run npm run sync:extension-package-invariants.',
    );
    return;
  }

  const expectedSnapshot = readJson(snapshotPath);
  const actualText = `${JSON.stringify(actualSnapshot, null, 2)}\n`;
  const expectedText = `${JSON.stringify(expectedSnapshot, null, 2)}\n`;

  assert(
    actualText === expectedText,
    [
      'Extension package invariants are out of sync.',
      'Run npm run sync:extension-package-invariants and review the manifest/resource changes.',
    ].join(' '),
    failures,
  );
}

function verifyAssets(snapshot, failures) {
  for (const assetPath of snapshot.manifestAssetReferences) {
    assert(
      relativeExists(assetPath),
      `Manifest asset is missing: ${assetPath}`,
      failures,
    );
  }

  for (const packagedPath of snapshot.requiredPackagedPaths) {
    if (BUILD_TIME_PACKAGED_PATHS.has(packagedPath)) continue;
    const absolutePath = path.join(packageDir, packagedPath);
    const exists = fs.existsSync(absolutePath);
    assert(
      exists,
      `Required extension package path is missing: ${packagedPath}`,
      failures,
    );
    if (exists && fs.statSync(absolutePath).isDirectory()) {
      assert(
        hasFiles(packagedPath),
        `Required extension package directory is empty: ${packagedPath}`,
        failures,
      );
    }
  }
}

function verifyVscodeIgnore(snapshot, failures) {
  if (!fs.existsSync(vscodeIgnorePath)) {
    failures.push(
      `Missing ${path.relative(rootDir, vscodeIgnorePath)}. Add package ignore rules before moving the extension package.`,
    );
    return;
  }

  const lines = fs
    .readFileSync(vscodeIgnorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());

  for (const line of snapshot.requiredVscodeIgnoreLines) {
    assert(
      lines.includes(line),
      `.vscodeignore must include ${line} so extension resources stay packaged after the workspace split.`,
      failures,
    );
  }
}

const update = process.argv.includes('--update');
const snapshot = buildSnapshot();

if (update) {
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log('Updated extension package invariant snapshot');
  process.exit(0);
}

const failures = [];
verifySnapshot(snapshot, failures);
verifyAssets(snapshot, failures);
verifyVscodeIgnore(snapshot, failures);

if (failures.length > 0) {
  console.error('Extension package invariant check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Extension package invariants are in sync');
