import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function walkFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(target, predicate);
      return !predicate || predicate(entry.name) ? [target] : [];
    }),
  );
  return nested.flat();
}
