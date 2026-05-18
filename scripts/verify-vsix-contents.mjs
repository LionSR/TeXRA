import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const extensionDir = path.join(rootDir, 'packages', 'extension');
const snapshotPath = path.join(
  rootDir,
  'scripts',
  'extension-package-invariants.snapshot.json',
);

function defaultVsixPath() {
  const packageJson = readJson(path.join(extensionDir, 'package.json'));
  return path.join(rootDir, 'releases', `texra-${packageJson.version}.vsix`);
}

function unzip(args, options = {}) {
  return execFileSync('unzip', args, {
    cwd: rootDir,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
}

function listVsixEntries(vsixPath) {
  return new Set(unzip(['-Z1', vsixPath]).split(/\r?\n/).filter(Boolean));
}

function readVsixEntry(vsixPath, entryPath) {
  return unzip(['-p', vsixPath, entryPath], { encoding: 'buffer' });
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walkFiles(dir, prefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results.sort();
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function assertEntryExists(entries, entryPath, failures) {
  assert(entries.has(entryPath), `VSIX is missing ${entryPath}`, failures);
}

function verifyManifest(vsixPath, snapshot, failures) {
  const manifestBytes = readVsixEntry(vsixPath, 'extension/package.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifestSnapshot = extensionManifestSnapshot(
    manifest,
    Object.keys(snapshot.manifest),
  );

  const actualText = `${JSON.stringify(manifestSnapshot, null, 2)}\n`;
  const expectedText = `${JSON.stringify(snapshot.manifest, null, 2)}\n`;
  assert(
    actualText === expectedText,
    'VSIX extension/package.json no longer matches the extension manifest snapshot.',
    failures,
  );
}

function verifyRequiredPaths(entries, snapshot, failures) {
  const entryList = [...entries];
  for (const packagedPath of snapshot.requiredPackagedPaths) {
    const entryPrefix = `extension/${packagedPath}`;
    const exists =
      entries.has(entryPrefix) ||
      entryList.some((entry) => entry.startsWith(`${entryPrefix}/`));
    assert(
      exists,
      `VSIX is missing required packaged path ${packagedPath}`,
      failures,
    );
  }
}

function verifyResourceHashes(vsixPath, entries, failures) {
  const resourcesDir = path.join(extensionDir, 'resources');
  const sourceFiles = walkFiles(resourcesDir);
  const sourceFileSet = new Set(sourceFiles);

  for (const sourceFile of sourceFiles) {
    const entryPath = `extension/resources/${sourceFile}`;
    assertEntryExists(entries, entryPath, failures);
    if (!entries.has(entryPath)) continue;

    const sourcePath = path.join(resourcesDir, sourceFile);
    const sourceHash = hashBuffer(fs.readFileSync(sourcePath));
    const packagedHash = hashBuffer(readVsixEntry(vsixPath, entryPath));
    assert(
      sourceHash === packagedHash,
      `VSIX resource hash mismatch for resources/${sourceFile}`,
      failures,
    );
  }

  for (const entry of entries) {
    if (!entry.startsWith('extension/resources/')) continue;
    const sourceFile = entry.slice('extension/resources/'.length);
    assert(
      sourceFileSet.has(sourceFile),
      `VSIX contains resource without source counterpart: resources/${sourceFile}`,
      failures,
    );
  }
}

function readSnapshot() {
  if (!fs.existsSync(snapshotPath)) {
    console.error(
      'Missing scripts/extension-package-invariants.snapshot.json. Run npm run sync:extension-package-invariants first.',
    );
    process.exit(1);
  }

  try {
    return readJson(snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not read scripts/extension-package-invariants.snapshot.json: ${message}`,
    );
    console.error(
      'Run npm run sync:extension-package-invariants and review the snapshot diff.',
    );
    process.exit(1);
  }
}

function verifyDistEntrypoints(entries, failures) {
  for (const entryPath of [
    'extension/dist/extension.js',
    'extension/dist/progressView/bundle.js',
    'extension/dist/settingsView/bundle.js',
    'extension/dist/webview/bundle.js',
    // Shared commons bundle is referenced from every webview HTML template via
    // BaseViewContentProvider. Missing this file would silently break webviews.
    'extension/dist/shared/commons.js',
  ]) {
    assertEntryExists(entries, entryPath, failures);
  }
}

function verifyPackagedDocs(vsixPath, entries, failures) {
  const manifest = readJson(path.join(extensionDir, 'package.json'));
  const repositoryUrl = String(manifest.repository?.url ?? '').replace(
    /\.git$/,
    '',
  );

  for (const [sourceName, packagedName] of [
    ['README.md', 'readme.md'],
    ['CHANGELOG.md', 'changelog.md'],
  ]) {
    const entryPath = `extension/${packagedName}`;
    assertEntryExists(entries, entryPath, failures);
    if (!entries.has(entryPath)) continue;

    const expected = normalizePackagedMarkdown(
      fs.readFileSync(path.join(rootDir, sourceName), 'utf8'),
      repositoryUrl,
    );
    const actual = readVsixEntry(vsixPath, entryPath).toString('utf8');
    assert(
      expected === actual,
      `VSIX ${packagedName} does not match the repository ${sourceName}`,
      failures,
    );
  }
}

function normalizePackagedMarkdown(markdown, repositoryUrl) {
  return markdown.replaceAll(
    /\]\((?![a-z][a-z+.-]*:|#|mailto:)([^)]+)\)/gi,
    (_match, target) => `](${repositoryUrl}/blob/HEAD/${target})`,
  );
}

const vsixPath = path.resolve(process.argv[2] ?? defaultVsixPath());
if (!fs.existsSync(vsixPath)) {
  console.error(
    `Missing VSIX artifact at ${path.relative(rootDir, vsixPath)}. Run npm run build:fast first.`,
  );
  process.exit(1);
}

const snapshot = readSnapshot();
const entries = listVsixEntries(vsixPath);
const failures = [];

verifyManifest(vsixPath, snapshot, failures);
verifyRequiredPaths(entries, snapshot, failures);
verifyResourceHashes(vsixPath, entries, failures);
verifyDistEntrypoints(entries, failures);
verifyPackagedDocs(vsixPath, entries, failures);

if (failures.length > 0) {
  console.error('VSIX content check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `VSIX content check passed for ${path.relative(rootDir, vsixPath)}`,
);
