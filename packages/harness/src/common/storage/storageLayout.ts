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
  type FileLocation,
  RunIdSchema,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core/pathBasics';
import { getPathSegments, isPathWithin } from '@utils/core/pathCore';
import { entryTypeIn } from '@utils/files/fsEntryExists';

import { pathToLocationIn } from './fileLocation';

/** Root collection names shared by storage providers and persisted stores. */
export const WORKSPACE_STORAGE_LAYOUT = Object.freeze({
  memory: 'memories',
  runs: 'executions',
} as const);

/** Where a tool plugin's bundled `kind` ships under a host's packaged
 *  resources root: `<resources>/plugins/<id>/<kind>`. A plugin that ships
 *  none has no such directory, which reads as none. */
export function bundledPluginDir(
  resourcesPath: string,
  pluginId: string,
  kind: 'skills' | 'agents',
): string {
  return path.join(resourcesPath, 'plugins', pluginId, kind);
}

/** Global (non-workspace-scoped) storage directory names, shared across hosts. */
export const CUSTOM_AGENTS_STORAGE_DIR = 'custom_agents';

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

  return {
    kind: 'runStorage',
    absolutePath: path.resolve(root, runRelativePath),
    relativePath: entrySegments.join('/'),
    runId: runId.success,
  };
}

/**
 * Where a path a run reads from lives, under the roots its caller holds: a
 * file in run storage keeps its run's provenance, anything else is its
 * workspace or external location.
 */
export function sourceLocationUnder(
  roots: { readonly storage: string; readonly workspace: string | undefined },
  inputPath: string,
): FileLocation {
  return (
    runStorageLocationUnder(roots.storage, inputPath) ??
    pathToLocationIn(roots.workspace, inputPath)
  );
}

/** One run-relative entry of a run's storage, read without following a link. */
export type RunStorageEntry =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Inspect one run-relative entry of run `runId`'s storage under
 * `storageRoot` without following a workspace-mirror symlink, the entry's
 * own or an ancestor directory's.
 */
export const runEntryUnder = Effect.fn('runStorage.runEntry')(function* (
  storageRoot: string,
  runId: RunId,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const runDirectory = runDirUnder(storageRoot, runId);
  const posixPath = normalizeFilePath(relativePath);
  const pathSegments = getPathSegments(posixPath);
  if (
    pathSegments.length === 0 ||
    path.posix.isAbsolute(posixPath) ||
    path.win32.isAbsolute(relativePath) ||
    pathSegments.includes('..')
  ) {
    return {
      kind: 'invalid',
      reason:
        'Run-storage paths must be non-empty relative paths without parent traversal.',
    } satisfies RunStorageEntry;
  }
  const normalizedPath = path.posix.normalize(posixPath);
  // Every directory the walk descends through, run root first, with the
  // entry's own path excluded: one path per prefix of `pathSegments`.
  const ancestors = [
    runDirectory,
    ...pathSegments
      .slice(0, -1)
      .map((_, index) =>
        path.join(runDirectory, ...pathSegments.slice(0, index + 1)),
      ),
  ];
  for (const ancestor of ancestors) {
    const ancestorType = yield* entryTypeIn(fs, ancestor);
    if (ancestorType === undefined)
      return { kind: 'missing' } satisfies RunStorageEntry;
    if (ancestorType === 'SymbolicLink')
      return {
        kind: 'symlink',
        absolutePath: ancestor,
      } satisfies RunStorageEntry;
    if (ancestorType !== 'Directory')
      return {
        kind: 'unsupported',
        absolutePath: ancestor,
      } satisfies RunStorageEntry;
  }

  const absolutePath = path.join(runDirectory, normalizedPath);
  const type = yield* entryTypeIn(fs, absolutePath);
  const entry: RunStorageEntry =
    type === undefined
      ? { kind: 'missing' }
      : type === 'SymbolicLink'
        ? { kind: 'symlink', absolutePath }
        : type === 'File'
          ? {
              kind: 'file',
              location: {
                kind: 'runStorage',
                absolutePath,
                relativePath: normalizedPath,
                runId,
              },
            }
          : type === 'Directory'
            ? { kind: 'directory', absolutePath }
            : { kind: 'unsupported', absolutePath };
  return entry;
});
