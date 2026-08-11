import * as path from 'node:path';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import type { FileStat } from '@platform/interfaces';
import { byStringProp, normalizeFilePath } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';

interface ExecutionWorkspaceFile {
  readonly path: string;
  readonly displayPath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

export function resolveExecutionWorkspaceFilePath(
  config: Pick<AgentConfig, 'workingDirectory'> | null,
  filePath: string,
): { readonly absolutePath: string; readonly path: string } | undefined {
  const workspaceRoot = config?.workingDirectory?.trim();
  const cleanedPath = filePath.trim();
  if (!workspaceRoot || !cleanedPath) return undefined;

  const absoluteRoot = path.resolve(workspaceRoot);
  const absolutePath = path.isAbsolute(cleanedPath)
    ? path.normalize(cleanedPath)
    : path.resolve(absoluteRoot, cleanedPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (!isStrictlyWithin(absoluteRoot, absolutePath)) {
    return undefined;
  }

  return {
    absolutePath,
    path: normalizeFilePath(relativePath),
  };
}

export async function listExecutionWorkspaceFiles(
  config: Pick<AgentConfig, 'workingDirectory'> | null,
  filePaths: readonly string[],
): Promise<ExecutionWorkspaceFile[]> {
  const files = new Map<string, ExecutionWorkspaceFile>();
  for (const filePath of filePaths) {
    const resolved = resolveExecutionWorkspaceFilePath(config, filePath);
    if (!resolved || files.has(resolved.path)) continue;

    let stat: FileStat;
    try {
      stat = await AbsoluteFS.stat(resolved.absolutePath);
    } catch (error) {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) continue;
      throw error;
    }

    files.set(resolved.path, {
      path: resolved.path,
      displayPath: `workspace/${resolved.path}`,
      absolutePath: resolved.absolutePath,
      size: stat.size,
      isDirectory: isDirectory(stat.type),
    });
  }
  return [...files.values()].sort(byStringProp((f) => f.path));
}
