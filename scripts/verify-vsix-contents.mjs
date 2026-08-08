import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_DERIVED_CONTRIBUTES,
  collectRelativeFiles,
  EXCLUDED_TRACE_VIEWER_DIR,
  extensionManifestSnapshot,
  readJson,
  REQUIRED_CATALOG_CONTRIBUTES,
  withoutCatalogDerivedContributes,
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

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function assertEntryExists(entries, entryPath, failures) {
  assert(entries.has(entryPath), `VSIX is missing ${entryPath}`, failures);
}

function assertCatalogContributesShipped(manifest, failures) {
  // Release guard: withoutCatalogDerivedContributes() below deletes the
  // catalog-derived subtrees before comparison. Commands and keybindings must
  // remain non-empty; configuration may be absent when all settings are native.
  const contributes = manifest.contributes;
  for (const key of REQUIRED_CATALOG_CONTRIBUTES) {
    const value = contributes?.[key];
    const nonEmpty = Array.isArray(value)
      ? value.length > 0
      : Boolean(value) &&
        typeof value === 'object' &&
        Object.keys(value).length > 0;
    assert(
      nonEmpty,
      `VSIX extension/package.json is missing a non-empty contributes.${key}; the release would ship without it.`,
      failures,
    );
  }
}

function verifyManifest(vsixPath, snapshot, failures) {
  const manifestBytes = readVsixEntry(vsixPath, 'extension/package.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertCatalogContributesShipped(manifest, failures);
  // The built VSIX ships the full contributes (catalog-derived subtrees
  // included); the committed snapshot omits them, so trim the same subtrees
  // here before comparing. This only affects the comparison, not the shipped
  // package.json.
  const manifestSnapshot = extensionManifestSnapshot(
    withoutCatalogDerivedContributes(manifest),
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

// See packages/extension/.vscodeignore for why resources/traceViewerShared is
// excluded from the packaged VSIX (~3.4MB of CLI-only dead weight).
const RESOURCE_HASH_EXCLUDED_PREFIX = `${EXCLUDED_TRACE_VIEWER_DIR}/`;

function verifyResourceHashes(vsixPath, entries, failures) {
  const resourcesDir = path.join(extensionDir, 'resources');
  const sourceFiles = collectRelativeFiles(resourcesDir).filter(
    (file) => !file.startsWith(RESOURCE_HASH_EXCLUDED_PREFIX),
  );
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
  ]) {
    assertEntryExists(entries, entryPath, failures);
  }
}

// The extension host renders diffs through VS Code's own `vscode.diff` and
// contains no Monaco code — Monaco belongs to the desktop renderer alone. But
// Vite emits a worker bundle for every `import('...?worker')` expression it
// sees in the module graph, at transform time, *before* tree-shaking: one
// webview module importing anything out of `@shared/monaco/monacoLoader` wrote
// ~12MB of unreachable Monaco language workers into the VSIX once already, with
// nothing failing. Pin it — the workers are never referenced by shipped code,
// so their presence is always a bundling accident.
const MONACO_WORKER_ENTRY =
  /\/(?:\w+\.worker-\w+\.js|editorWebWorkerMain\.js)$/;

function verifyNoMonacoWorkers(entries, failures) {
  const workers = [...entries].filter((entry) =>
    MONACO_WORKER_ENTRY.test(entry),
  );
  assert(
    workers.length === 0,
    `VSIX contains Monaco worker bundles that no shipped code loads: ${workers.join(', ')}. ` +
      'Something in a webview graph now imports @shared/monaco/monacoLoader — ' +
      'import @shared/monaco/monacoLanguage instead if you only need a language id.',
    failures,
  );
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
verifyNoMonacoWorkers(entries, failures);
verifyPackagedDocs(vsixPath, entries, failures);

if (failures.length > 0) {
  console.error('VSIX content check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `VSIX content check passed for ${path.relative(rootDir, vsixPath)}`,
);
