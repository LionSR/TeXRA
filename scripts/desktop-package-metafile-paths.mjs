import { posix } from 'node:path';

export function normalizeMetafilePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function resolveMetafileImportPath(outputPath, importPath) {
  const normalizedImportPath = importPath.replaceAll('\\', '/');
  if (normalizedImportPath.startsWith('.')) {
    return normalizeMetafilePath(
      posix.normalize(
        posix.join(posix.dirname(outputPath), normalizedImportPath),
      ),
    );
  }
  return posix.normalize(normalizedImportPath);
}
