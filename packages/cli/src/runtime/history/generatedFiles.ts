import * as path from 'node:path';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import type { ExecutionId } from '@shared/schemas';
import { isKVFile as isHistoryKvFile } from '@tools/executions/executionKvFiles';
import { byStringProp } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since the input is a workspace-relative path produced by
// the storage directory walk below, not raw user input.
import { toPosixPath } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/runStorageFs';

import type { CliHistoryFile } from '../history';

const HISTORY_FILE_SCAN_DEPTH = 2;

export async function listGeneratedFiles(
  id: ExecutionId,
): Promise<CliHistoryFile[]> {
  const runDir = await findExistingRunStoragePath(id);
  if (!runDir) return [];
  return walkStorageDirectory(runDir, '', HISTORY_FILE_SCAN_DEPTH);
}

async function walkStorageDirectory(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Promise<CliHistoryFile[]> {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
  const entries = await StorageFS.readDir(fullPath).catch((error: unknown) => {
    if (isFileNotFoundError(error)) return [];
    throw error;
  });

  const files: CliHistoryFile[] = [];
  for (const [name, type] of entries) {
    if (isHistoryKvFile(name)) continue;
    const rawRelative = relativePath ? path.join(relativePath, name) : name;
    const childPath = path.join(basePath, rawRelative);
    const entryIsDirectory = isDirectory(type);
    try {
      const stat = await StorageFS.stat(childPath);
      files.push({
        path: toPosixPath(rawRelative),
        size: stat.size,
        isDirectory: entryIsDirectory,
      });
    } catch (error) {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) continue;
      throw error;
    }
    if (entryIsDirectory && maxDepth > 1) {
      files.push(
        ...(await walkStorageDirectory(basePath, rawRelative, maxDepth - 1)),
      );
    }
  }
  return files.sort(byStringProp((f) => f.path));
}

export function mergeHistoryFiles(
  ...fileGroups: readonly (readonly CliHistoryFile[])[]
): CliHistoryFile[] {
  const files = new Map<string, CliHistoryFile>();
  for (const group of fileGroups) {
    for (const file of group) {
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  return [...files.values()].sort(byStringProp((f) => f.path));
}
