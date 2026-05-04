import fs from 'node:fs';

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
