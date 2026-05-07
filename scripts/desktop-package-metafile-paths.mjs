import { posix } from 'node:path';

export function normalizeMetafilePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isRelativeMetafileImportPath(path) {
  return (
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.startsWith('../')
  );
}

export function resolveMetafileImportPath(outputPath, importPath) {
  const normalizedImportPath = importPath.replaceAll('\\', '/');
  if (isRelativeMetafileImportPath(normalizedImportPath)) {
    return normalizeMetafilePath(
      posix.normalize(
        posix.join(posix.dirname(outputPath), normalizedImportPath),
      ),
    );
  }
  return normalizeMetafilePath(posix.normalize(normalizedImportPath));
}
