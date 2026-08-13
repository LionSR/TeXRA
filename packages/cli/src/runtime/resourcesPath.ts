import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findCliPackageDir(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      path.basename(dir) === 'cli' &&
      existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function resolveCliResourcesPath(anchorUrl = import.meta.url): string {
  const currentDir = path.dirname(fileURLToPath(anchorUrl));
  const packageDir = findCliPackageDir(currentDir);
  const candidates = [
    path.resolve(currentDir, '../resources'),
    path.resolve(packageDir, 'dist/resources'),
    path.resolve(packageDir, '../extension/resources'),
    path.resolve(currentDir, '../../../extension/resources'),
    path.resolve(currentDir, '../../extension/resources'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
