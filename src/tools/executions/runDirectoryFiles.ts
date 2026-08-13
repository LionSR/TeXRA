/**
 * Storage-directory traversal for an execution's generated files.
 * Walks the run directory (bounded depth) and filters out the internal KV
 * metadata blobs that live alongside generated output.
 */

import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

import { isKVFile } from './executionKvFiles';
import type { SizedEntry } from './fileListingFormat';

async function walkDirectory(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Promise<SizedEntry[]> {
  const results: SizedEntry[] = [];
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(fullPath);
  } catch {
    // Directory doesn't exist or can't be read
    return results;
  }

  for (const [name, type] of entries) {
    // Build raw path for filesystem access (preserves platform separators),
    // then normalize to forward slashes only for display output.
    const entryRaw = path.join(relativePath, name);
    const entryRelative = normalizeFilePath(entryRaw);
    const entryFull = path.join(basePath, entryRaw);
    const isDir = isDirectory(type);

    try {
      const stats = await StorageFS.stat(entryFull);
      results.push({ path: entryRelative, size: stats.size, isDir });

      if (isDir && maxDepth > 1) {
        results.push(
          ...(await walkDirectory(basePath, entryRaw, maxDepth - 1)),
        );
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return results;
}

/**
 * List the generated (non-KV) files under a run directory, recursing up to
 * two levels deep.
 */
export async function listRunDirectoryFiles(
  runDir: string,
): Promise<SizedEntry[]> {
  const entries = await walkDirectory(runDir, '', 2);
  return entries.filter((entry) => !isKVFile(path.basename(entry.path)));
}
