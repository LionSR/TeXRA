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

// contributes.configuration/commands/keybindings are generated from
// src/shared/schemas/coreSettings.ts and src/shared/commands/catalog.ts (see
// scripts/sync-extension-manifest.mjs) and verified against package.json by
// that script's --check mode plus the settingsConfiguration/CommandCatalog
// Vitest suites. They don't need a second, frozen-snapshot copy here — that
// copy is what previously made the invariants snapshot ~70 KB and turned a
// catalog rename into a generic snapshot mismatch instead of a targeted diff.
export const CATALOG_DERIVED_CONTRIBUTES_KEYS = [
  'configuration',
  'commands',
  'keybindings',
];

export function withoutCatalogDerivedContributes(packageJson) {
  const contributes = { ...packageJson.contributes };
  for (const key of CATALOG_DERIVED_CONTRIBUTES_KEYS) {
    delete contributes[key];
  }
  return { ...packageJson, contributes };
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
