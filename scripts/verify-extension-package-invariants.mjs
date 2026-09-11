import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectRelativeFiles,
  extensionManifestSnapshot,
  readJson,
  REQUIRED_PACKAGED_PATHS,
  reportCheckFailures,
} from './extension-package-utils.mjs';
import { walkFiles } from './walkFiles.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packagePath = path.join(rootDir, 'packages', 'extension', 'package.json');
const packageDir = path.dirname(packagePath);
const vscodeIgnorePath = path.join(packageDir, '.vscodeignore');

// Paths produced by the build from canonical repo-root sources. They do not
// need to exist in the extension source tree, but verify-vsix-contents.mjs
// still checks that the built VSIX includes them with matching hashes.
const BUILD_TIME_PACKAGED_PATHS = new Set(['readme.md', 'changelog.md']);

const REQUIRED_VSCODEIGNORE_LINES = [
  'src/**',
  '!src/common/styles/*.css',
  '!src/progressView/*.html',
  '!src/settingsView/*.html',
];

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
  const manifest = extensionManifestSnapshot(packageJson);
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

function isBuildTimePackagedPath(relativePath) {
  const normalizedPath = relativePath.replace(/^\.\//, '');
  for (const buildTimePath of BUILD_TIME_PACKAGED_PATHS) {
    if (
      normalizedPath === buildTimePath ||
      normalizedPath.startsWith(`${buildTimePath}/`)
    ) {
      return true;
    }
  }
  return false;
}

function hasFiles(relativeDir) {
  const absoluteDir = path.join(packageDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return false;
  return walkFiles(absoluteDir, { limit: 1 }).length > 0;
}

function verifyAssets(packageJson, failures) {
  for (const assetPath of manifestAssetReferences(packageJson)) {
    if (isBuildTimePackagedPath(assetPath)) continue;
    assert(
      relativeExists(assetPath),
      `Manifest asset is missing: ${assetPath}`,
      failures,
    );
  }

  for (const packagedPath of REQUIRED_PACKAGED_PATHS) {
    if (isBuildTimePackagedPath(packagedPath)) continue;
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

function verifyBundledSkills(packageJson, failures) {
  const sourceDir = path.join(packageDir, 'resources', 'skills');
  const sourceExists = fs.existsSync(sourceDir);
  assert(sourceExists, 'Bundled skills directory is missing.', failures);
  if (!sourceExists) return;

  const sourceFiles = collectRelativeFiles(sourceDir);
  const chatSkills = packageJson.contributes?.chatSkills ?? [];
  const expectedNames = sourceFiles
    .filter((relativePath) => /^[^/]+\/SKILL\.md$/.test(relativePath))
    .map((relativePath) => relativePath.split('/')[0]);
  assert(
    JSON.stringify(chatSkills.map((skill) => skill.name).toSorted()) ===
      JSON.stringify(expectedNames.toSorted()),
    'Extension chatSkills must register every bundled skill.',
    failures,
  );

  for (const skill of chatSkills) {
    const expectedPath = `resources/skills/${skill.name}/SKILL.md`;
    assert(
      skill.path === expectedPath,
      `Chat skill ${skill.name} must point to ${expectedPath}.`,
      failures,
    );
  }
}

function verifyVscodeIgnore(failures) {
  if (!fs.existsSync(vscodeIgnorePath)) {
    failures.push(`Missing ${path.relative(rootDir, vscodeIgnorePath)}.`);
    return;
  }

  const lines = fs
    .readFileSync(vscodeIgnorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());

  for (const line of REQUIRED_VSCODEIGNORE_LINES) {
    assert(
      lines.includes(line),
      `.vscodeignore must include ${line} so the VSIX ships the webview entry points and no TypeScript sources.`,
      failures,
    );
  }
}

const packageJson = readJson(packagePath);
const failures = [];
verifyAssets(packageJson, failures);
verifyBundledSkills(packageJson, failures);
verifyVscodeIgnore(failures);

reportCheckFailures('Extension package invariant check', failures);

console.log('Extension package invariants hold');
