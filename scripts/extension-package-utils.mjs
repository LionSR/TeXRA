import fs from 'node:fs';
import path from 'node:path';

export const vscodeRuntimeImportPattern =
  /\b(?:import\s*\(\s*['"]vscode['"]\s*\)|import\s+[^;]*\s+from\s+['"]vscode['"]|(?:__require|require|requireFn)(?:\?\.)?\(\s*['"]vscode['"]\s*\))/;

export const vscodeBackedStateImportPattern =
  /(?:^\s*(?:(?:import(?:\s+type)?(?:\s+[^;]*?\s+from)?)|(?:export(?:\s+type)?\s+[^;]*?\s+from))\s+['"]@common\/state(?:\/stateManager)?['"])|(?:\bimport\s*\(\s*['"]@common\/state(?:\/stateManager)?['"]\s*\))/m;

export const requiredMonacoWorkers = [
  'editor.worker',
  'json.worker',
  'css.worker',
  'html.worker',
  'ts.worker',
];

const desktopSharedSourceDirSegments = [
  ['packages', 'desktop', 'src'],
  ['src', 'agent'],
  ['src', 'controllers'],
  ['src', 'eventBus'],
  ['src', 'latex'],
  ['src', 'logger'],
  ['src', 'model'],
  ['src', 'replacement'],
  ['src', 'shared'],
  ['src', 'tools'],
  ['src', 'utils'],
];

const desktopVscodeFreeSourceDirSegments = [
  ...desktopSharedSourceDirSegments,
  ['src', 'common', 'errors'],
];

export function getDesktopSharedSourceDirs(rootDir) {
  return desktopSharedSourceDirSegments.map((segments) =>
    path.join(rootDir, ...segments),
  );
}

export function getDesktopVscodeFreeSourceDirs(rootDir) {
  return desktopVscodeFreeSourceDirSegments.map((segments) =>
    path.join(rootDir, ...segments),
  );
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Return recursive file paths with stable VSIX-compatible separators. */
export function collectRelativeFiles(directory) {
  const visit = (currentDirectory, prefix) => {
    const files = [];
    for (const entry of fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        files.push(...visit(absolutePath, relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
    return files;
  };

  return visit(directory, '').sort();
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

// Catalog-derived `contributes` subtrees. These are code-generated from the
// settings/command catalogs by scripts/sync-package-contributes.mjs and
// diff-checked by the catalog vitest suites, so snapshotting them would just
// duplicate that guard with ~35 KB of committed generated JSON. They are
// omitted from the manifest snapshot (verify-extension-package-invariants.mjs)
// and from the built-VSIX manifest comparison (verify-vsix-contents.mjs); the
// remaining non-catalog contributes (menus, views, walkthroughs, …) and
// manifest keys stay guarded.
export const CATALOG_DERIVED_CONTRIBUTES = [
  'configuration',
  'commands',
  'keybindings',
];

// A native-settings-only extension legitimately has no VS Code configuration
// contribution. Commands and keybindings must still be present in every VSIX.
export const REQUIRED_CATALOG_CONTRIBUTES = ['commands', 'keybindings'];

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
