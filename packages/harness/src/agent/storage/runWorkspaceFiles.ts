import * as path from 'node:path';

import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { normalizeFilePath } from '@utils/core';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { entryMetadataAt } from '@utils/files/fsDurability';
import { absentReason } from '@utils/files/fsEntryExists';

/** A workspace file a run edited, as it stands now. */
export interface RunWorkspaceFile {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

export function resolveRunWorkspaceFilePath(
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

export const listRunWorkspaceFiles = Effect.fn('storage.listRunWorkspaceFiles')(
  function* (
    config: Pick<AgentConfig, 'workingDirectory'> | null,
    filePaths: readonly string[],
  ) {
    const resolved = new Map<string, string>();
    for (const filePath of filePaths) {
      const target = resolveRunWorkspaceFilePath(config, filePath);
      if (target && !resolved.has(target.path))
        resolved.set(target.path, target.absolutePath);
    }
    const files = yield* Effect.forEach(
      resolved,
      ([relative, absolutePath]) =>
        // A path recorded for the run that is no longer there — or whose
        // parent is not a directory any more — is simply not listed; every
        // other failure propagates, so an unreadable entry is never reported
        // as a missing one.
        entryMetadataAt(absolutePath).pipe(
          Effect.map((entry): RunWorkspaceFile[] => [
            {
              path: relative,
              size: entry.size,
              isDirectory: entry.type === 'Directory',
            },
          ]),
          Effect.catchIf(absentReason, () => Effect.succeed([])),
        ),
      { concurrency: 8 },
    );
    return files.flat().sort((a, b) => a.path.localeCompare(b.path));
  },
);
