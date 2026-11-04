/**
 * The layout of a storage root: its collection names, and the run
 * directories under it. Every path helper takes the storage root as data; a
 * caller holds that root already (a tool call's `roots`, a run's session
 * roots, a host's `WorkspaceRoots`), so none of them reads an ambient root.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result, Schema } from 'effect';

// Local imports
import {
  RunIdSchema,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { getPathSegments, isPathWithin } from '@utils/core/pathCore';
import { entryExists } from '@utils/files/fsEntryExists';

import { createRunStorageLocation } from './fileLocation';

/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = Object.freeze({
  memory: 'memories',
  runs: 'executions',
  original: 'original',
} as const);

/** Global (non-workspace-scoped) storage directory names, shared across hosts. */
export const CUSTOM_AGENTS_STORAGE_DIR = 'custom_agents';

/**
 * Workspace-relative directories that should never be moved into run storage.
 *
 * History folders contain prior run data that is managed separately,
 * so keep them in place even when run-storage isolation is enabled.
 */
const IGNORED_WORKSPACE_ROOTS = new Set(['History', 'history']);

/** Whether a workspace-relative path stays out of run storage. */
export function shouldSkipRelocation(relativePath: string): boolean {
  const segments = getPathSegments(relativePath);
  return segments.length > 0 && IGNORED_WORKSPACE_ROOTS.has(segments[0]);
}

/** A storage-relative (POSIX) path under the runs directory. */
function resolveRunStoragePath(...segments: string[]): string {
  return path.posix.join(WORKSPACE_STORAGE_LAYOUT.runs, ...segments);
}

function runStorageRelativePath(
  absolutePath: string,
  runDirectory: string,
): string | undefined {
  if (!isPathWithin(runDirectory, absolutePath)) return undefined;
  return (
    normalizeFilePath(path.relative(runDirectory, absolutePath)) || undefined
  );
}

/** A run's directory under `storageRoot`. */
export function runDirUnder(storageRoot: string, id: RunId): string {
  return path.join(storageRoot, resolveRunStoragePath(id));
}

/**
 * The run-storage-relative path of `segments` under `storageRoot` when it
 * exists, so a caller that addresses run storage by relative path (the
 * storage view's own vocabulary) keeps doing so.
 */
export const findExistingRunStoragePathUnder = Effect.fn(
  'runStorage.findExistingRunStoragePath',
)(function* (storageRoot: string, ...segments: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const storagePath = resolveRunStoragePath(...segments);
  return (yield* entryExists(fs, path.join(storageRoot, storagePath)))
    ? storagePath
    : undefined;
});

/** Create a run's directory under `storageRoot`, runs directory included. */
export const ensureRunDirUnder = Effect.fn('runStorage.ensureRunDir')(
  function* (storageRoot: string, id: RunId) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(runDirUnder(storageRoot, id), { recursive: true });
  },
);

/** An absolute path inside a run's directory under `storageRoot`. */
export function runStorageAbsolutePathUnder(
  storageRoot: string,
  id: RunId,
  workspaceRelative: string,
): string {
  return path.join(storageRoot, resolveRunStoragePath(id, workspaceRelative));
}

/**
 * Recover run identity from an absolute path inside the runs directory under
 * `storageRoot`.
 */
export function runStorageLocationUnder(
  storageRoot: string,
  absolutePath: string,
): RunStorageFileLocation | undefined {
  if (!path.isAbsolute(absolutePath)) return undefined;

  const root = path.join(storageRoot, resolveRunStoragePath());
  const runRelativePath = runStorageRelativePath(absolutePath, root);
  if (!runRelativePath) return undefined;

  const [rawRunId, ...entrySegments] = getPathSegments(runRelativePath);
  const runId = Schema.decodeUnknownResult(RunIdSchema)(rawRunId);
  if (Result.isFailure(runId) || entrySegments.length === 0) return undefined;

  return createRunStorageLocation(
    path.resolve(root, runRelativePath),
    entrySegments.join('/'),
    runId.success,
  );
}
