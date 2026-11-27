import { Effect, type FileSystem } from 'effect';

import {
  runEntryUnder,
  runStorageLocationUnder,
} from '@common/storage/storageLayout';
import { SessionRoots } from '@platform/rootedFs';
import {
  ToolError,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';

/**
 * Resolve a file of the calling run's own storage; another run's storage is
 * refused. The absolute path is only a lookup token.
 */
export const resolveOwnRunFile = Effect.fn('resolveOwnRunFile')(function* (
  parentId: RunId,
  absolutePath: string,
): Effect.fn.Return<
  RunStorageFileLocation | undefined,
  Error,
  FileSystem.FileSystem | SessionRoots
> {
  const roots = yield* SessionRoots;
  const storageRoot = roots.storage;
  const reference = runStorageLocationUnder(storageRoot, absolutePath);
  if (!reference) {
    return yield* new ToolError('The file is not inside run storage.');
  }

  if (reference.runId !== parentId)
    return yield* new ToolError(
      `${reference.relativePath} is in the storage of run ${reference.runId}, not this run's.`,
    );

  const entry = yield* runEntryUnder(
    storageRoot,
    reference.runId,
    reference.relativePath,
  );
  switch (entry.kind) {
    case 'file':
      return entry.location;
    case 'symlink':
      return undefined;
    case 'missing':
      return yield* new ToolError(
        `${reference.relativePath} is missing from run ${reference.runId}.`,
      );
    case 'invalid':
      return yield* new ToolError(`Invalid run file: ${entry.reason}`);
    default:
      return yield* new ToolError(
        `${reference.relativePath} is not a regular file.`,
      );
  }
});
