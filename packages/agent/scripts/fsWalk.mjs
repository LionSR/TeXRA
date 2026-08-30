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
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) => !entry.isDirectory() && (!predicate || predicate(entry.name)),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}
