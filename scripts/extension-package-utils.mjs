import fs from 'node:fs';

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

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Return recursive file paths with stable VSIX-compatible separators. */
export function collectRelativeFiles(directory) {
  return walkFiles(directory)
    .map((entry) => entry.relativePath)
    .sort();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function extensionManifestSnapshot(packageJson, manifestKeys) {
  return Object.fromEntries(
    manifestKeys.map((key) => [key, stable(packageJson[key])]),
  );
}

// Catalog-derived `contributes` subtrees: code-generated from the command
// catalog by scripts/sync-package-contributes.mjs and diff-checked by the
// catalog vitest suites, so snapshotting them would just duplicate that guard
// with ~35 KB of committed generated JSON. They are omitted from the manifest
// snapshot (verify-extension-package-invariants.mjs) and from the built-VSIX
// manifest comparison (verify-vsix-contents.mjs), which instead asserts each
// one ships non-empty; the remaining non-catalog contributes (menus, views,
// walkthroughs, …) and manifest keys stay guarded. `configuration` is absent
// by design — settings are native, and sync-package-contributes.mjs throws
// outright if the manifest contributes it.
export const CATALOG_DERIVED_CONTRIBUTES = ['commands', 'keybindings'];

export function withoutCatalogDerivedContributes(packageJson) {
  const { contributes } = packageJson;
  if (!contributes || typeof contributes !== 'object') return packageJson;
  const trimmedContributes = { ...contributes };
  for (const key of CATALOG_DERIVED_CONTRIBUTES) delete trimmedContributes[key];
  return { ...packageJson, contributes: trimmedContributes };
}

// packages/extension/resources/traceViewerShared is the multi-file,
// external-assets trace-viewer build (shared-assets/site-hosting export
// mode) — CLI-only (packages/cli/src/runtime/history.ts), never referenced by
// the extension host, so packages/extension/.vscodeignore deliberately
// excludes it from the packaged VSIX. resources/traceViewer is the
// single-file default template and is packaged. One source of truth for the
// directory name so verify-extension-package-invariants.mjs's required
// .vscodeignore line and verify-vsix-contents.mjs's resource-hash exclusion
// can't drift apart.
export const EXCLUDED_TRACE_VIEWER_DIR = 'traceViewerShared';
