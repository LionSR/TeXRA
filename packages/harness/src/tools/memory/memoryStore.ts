/**
 * `MemoryStore`: the memory tree as a host reads and edits it outside a run,
 * for the settings view's Memory page, the CLI's `memory` command and the
 * TUI's `/memory`.
 *
 * Every member runs over the `StorageFs` the caller provides (its
 * session's storage view), so the tree is the one under the storage root the
 * caller chose. A memory is named the way a person names it: `/memories/<p>`
 * as the memory tool shows it, `memories/<p>` as the store holds it, or a
 * bare `<p>` under the memory root, taken exactly as given (a caller that
 * reads a typed argument trims it); the mutations take the memory tree's
 * lane, as every memory tool command does, so an edit from a host never races
 * an agent's edit beneath it.
 */
import { Effect, Result, type PlatformError } from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import type { StorageFs } from '@platform/rootedFs';
import { ToolError } from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';

import {
  deleteMemoryPath,
  loadMemoryItems,
  loadMemoryPreview,
  onMemoryTreeLane,
  setMemoryPinned,
} from './memoryFileSystem';
import {
  displayToStoragePath,
  MAX_PINNED_MEMORIES,
  MEMORY_DISPLAY_ROOT,
  toDisplayPath,
} from './memoryUtils';

/** The storage path of a memory named in any of the three forms; fails on
 *  a path outside the memory root. */
function storagePathOf(input: string): Result.Result<string, ToolError> {
  const named = normalizeFilePath(input);
  if (
    !named ||
    named === MEMORY_DISPLAY_ROOT ||
    named.startsWith(`${MEMORY_DISPLAY_ROOT}/`)
  ) {
    return displayToStoragePath(named || MEMORY_DISPLAY_ROOT);
  }
  if (
    named === WORKSPACE_STORAGE_LAYOUT.memory ||
    named.startsWith(`${WORKSPACE_STORAGE_LAYOUT.memory}/`)
  ) {
    // The store's own spelling: the same path under the display root.
    return displayToStoragePath(
      `${MEMORY_DISPLAY_ROOT}${named.slice(WORKSPACE_STORAGE_LAYOUT.memory.length)}`,
    );
  }
  if (named.startsWith('/') || /^[A-Za-z]:\//.test(named)) {
    return Result.fail(
      new ToolError(
        `Invalid memory path "${named}". Use ${MEMORY_DISPLAY_ROOT}, ${MEMORY_DISPLAY_ROOT}/<file>, ${WORKSPACE_STORAGE_LAYOUT.memory}/<file>, or a filename relative to ${MEMORY_DISPLAY_ROOT}.`,
      ),
    );
  }
  return displayToStoragePath(`${MEMORY_DISPLAY_ROOT}/${named}`);
}

/** A memory's storage path, or why the name is not one. */
const storagePath = (input: string): Effect.Effect<string, Error> =>
  Effect.fromResult(storagePathOf(input));

/** The storage path of one memory file a mutation acts on: the memory root
 *  itself is no memory, so a delete or pin of it is refused rather than
 *  acting on the whole tree. */
const memoryFilePath = (input: string): Effect.Effect<string, Error> =>
  Effect.flatMap(storagePath(input), (path) =>
    path === WORKSPACE_STORAGE_LAYOUT.memory
      ? Effect.fail(
          new Error(
            `"${input}" names the memory folder, not a memory; name one file under ${MEMORY_DISPLAY_ROOT}.`,
          ),
        )
      : Effect.succeed(path),
  );

/** One memory's bounded preview, with the path the memory tool shows. */
export interface MemoryPreview {
  readonly storagePath: string;
  readonly displayPath: string;
  readonly preview: string;
  /** Absent when the file did not fit the scan window. */
  readonly lineCount: number | undefined;
}

/** What a pin toggle did: `cap-reached` names the cap it hit. */
export type MemoryPinResult =
  | { readonly status: 'changed'; readonly pinnedCount: number }
  | { readonly status: 'already' }
  | { readonly status: 'cap-reached'; readonly max: number };

/** The memory tree's host-facing reads and edits, over the caller's
 *  `StorageFs`. */
export const MemoryStore = {
  /** The memory folder, relative to the storage root. */
  folder: WORKSPACE_STORAGE_LAYOUT.memory,
  /** The storage path of a memory named in any of the three forms. */
  storagePath,
  /** The path the memory tool shows for a storage path. */
  displayPath: toDisplayPath,
  /** Every memory, pinned first, then newest first; empty with no folder. */
  list: Effect.suspend(() => loadMemoryItems()),
  /** One memory's bounded preview. */
  preview: (
    input: string,
  ): Effect.Effect<
    MemoryPreview,
    Error | PlatformError.PlatformError,
    StorageFs
  > =>
    storagePath(input).pipe(
      Effect.flatMap(loadMemoryPreview),
      Effect.map((loaded): MemoryPreview => ({
        ...loaded,
        displayPath: toDisplayPath(loaded.storagePath),
      })),
    ),
  /** Delete a memory, on the memory tree's lane. */
  delete: (
    input: string,
  ): Effect.Effect<void, Error | PlatformError.PlatformError, StorageFs> =>
    memoryFilePath(input).pipe(
      Effect.flatMap((path) => deleteMemoryPath(path).pipe(onMemoryTreeLane)),
    ),
  /** Pin or unpin a memory, on the memory tree's lane. */
  pin: (
    input: string,
    pinned: boolean,
  ): Effect.Effect<
    MemoryPinResult,
    Error | PlatformError.PlatformError,
    StorageFs
  > =>
    memoryFilePath(input).pipe(
      Effect.flatMap((path) =>
        setMemoryPinned(path, pinned).pipe(onMemoryTreeLane),
      ),
      Effect.map((result): MemoryPinResult =>
        result.status === 'cap-reached'
          ? { status: 'cap-reached', max: MAX_PINNED_MEMORIES }
          : result,
      ),
    ),
};
