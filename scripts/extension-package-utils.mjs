import fs from 'node:fs';
import process from 'node:process';

import { walkFiles } from './walkFiles.mjs';

export const vscodeRuntimeImportPattern =
  /\b(?:import\s*\(\s*['"]vscode['"]\s*\)|import\s+[^;]*\s+from\s+['"]vscode['"]|(?:__require|require|requireFn)(?:\?\.)?\(\s*['"]vscode['"]\s*\))/;

export const requiredMonacoWorkers = [
  'editor.worker',
  'json.worker',
  'css.worker',
  'html.worker',
  'ts.worker',
];

/** Paths (files or non-empty directories) the extension VSIX must ship. */
export const REQUIRED_PACKAGED_PATHS = [
  'LICENSE.txt',
  'NOTICE.txt',
  'changelog.md',
  'readme.md',
  'resources/agents',
  'resources/docs/agent-creation',
  'resources/examples',
  'resources/logo-128x128.svg',
  'resources/logo-512x512.png',
  'resources/plugins',
  'resources/plugins/lean4/agents',
  'resources/skills',
  'resources/templates',
  'resources/walkthroughs',
  'src/common/styles/common.css',
  'src/progressView/index.html',
  'src/settingsView/index.html',
];

// The manifest keys VS Code reads; the built VSIX must ship them exactly as
// packages/extension/package.json declares them.
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

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Print accumulated failures under `label` and exit(1); no-op when empty. */
export function reportCheckFailures(label, failures) {
  if (failures.length === 0) return;
  console.error(`${label} failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

/** Return recursive file paths with stable VSIX-compatible separators. */
export function collectRelativeFiles(directory) {
  return walkFiles(directory)
    .map((entry) => entry.relativePath)
    .sort();
}

/** The manifest keys of `packageJson`, compared with `isDeepStrictEqual`. */
export function extensionManifestSnapshot(packageJson) {
  return Object.fromEntries(
    MANIFEST_KEYS.map((key) => [key, packageJson[key]]),
  );
}
