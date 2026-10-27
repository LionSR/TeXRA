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
    const resolvedByPath = new Map<
      string,
      { readonly absolutePath: string; readonly path: string }
    >();
    for (const filePath of filePaths) {
      const resolved = resolveRunWorkspaceFilePath(config, filePath);
      if (resolved && !resolvedByPath.has(resolved.path))
        resolvedByPath.set(resolved.path, resolved);
    }

    // A path recorded for the run that is no longer there — or whose parent
    // is not a directory any more — is simply not listed; every other failure
    // propagates, so an unreadable entry is never reported as a missing one.
    const entries = yield* Effect.forEach(
      resolvedByPath.values(),
      (resolved) =>
        entryMetadataAt(resolved.absolutePath).pipe(
          Effect.map((entry): RunWorkspaceFile => ({
            path: resolved.path,
            size: entry.size,
            isDirectory: entry.type === 'Directory',
          })),
          Effect.catchIf(absentReason, () => Effect.succeed(undefined)),
        ),
      { concurrency: 8 },
    );
    const files = entries.filter((entry) => entry !== undefined);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  },
);
