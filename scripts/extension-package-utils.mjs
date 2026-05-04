import fs from 'node:fs';
import path from 'node:path';

export const vscodeRuntimeImportPattern =
  /\b(?:import\s*\(\s*['"]vscode['"]\s*\)|import\s+[^;]*\s+from\s+['"]vscode['"]|(?:__require|require|requireFn)(?:\?\.)?\(\s*['"]vscode['"]\s*\))/;

export const vscodeBackedStateImportPattern =
  /(?:^\s*(?:(?:import(?:\s+type)?(?:\s+[^;]*?\s+from)?)|(?:export(?:\s+type)?\s+[^;]*?\s+from))\s+['"]@common\/state(?:\/stateManager)?['"])|(?:\bimport\s*\(\s*['"]@common\/state(?:\/stateManager)?['"]\s*\))/m;

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
