/**
 * The memory tree as a host reads and edits it outside a run: the settings
 * view's Memory page, the CLI's `memory` command and the TUI's `/memory`.
 *
 * Every member runs over the {@link StorageFs} the caller provides (its
 * session's storage view), so the tree is the one under the storage root the
 * caller chose. A memory is named the way a person names it: `/memories/<p>`
 * as the memory tool shows it, `memories/<p>` as the store holds it, or a
 * bare `<p>` under the memory root; the mutations take the memory tree's
 * lane, as every memory tool command does, so an edit from a host never races
 * an agent's edit beneath it.
 */
import { Effect, type PlatformError } from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import type { StorageFs } from '@platform/rootedFs';
import type { MemoryViewItem } from '@shared/tools/memoryView';
import { normalizeFilePath } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

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

/** The storage path of a memory named in any of the three forms; throws on
 *  a path outside the memory root. */
function storagePathOf(input: string): string {
  const named = normalizeFilePath(input.trim());
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
    throw new Error(
      `Invalid memory path "${named}". Use ${MEMORY_DISPLAY_ROOT}, ${MEMORY_DISPLAY_ROOT}/<file>, ${WORKSPACE_STORAGE_LAYOUT.memory}/<file>, or a filename relative to ${MEMORY_DISPLAY_ROOT}.`,
    );
  }
  return displayToStoragePath(`${MEMORY_DISPLAY_ROOT}/${named}`);
}

/** A memory's storage path, or why the name is not one. */
const storagePath = (input: string): Effect.Effect<string, Error> =>
  Effect.try({ try: () => storagePathOf(input), catch: ensureError });

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
 *  {@link StorageFs}. */
export const MemoryStore: {
  /** The memory folder, relative to the storage root. */
  readonly folder: string;
  /** The storage path of a memory named in any of the three forms. */
  readonly storagePath: (input: string) => Effect.Effect<string, Error>;
  /** Every memory, pinned first, then newest first; empty with no folder. */
  readonly list: Effect.Effect<
    MemoryViewItem[],
    PlatformError.PlatformError,
    StorageFs
  >;
  readonly preview: (
    input: string,
  ) => Effect.Effect<
    MemoryPreview,
    Error | PlatformError.PlatformError,
    StorageFs
  >;
  readonly delete: (
    input: string,
  ) => Effect.Effect<void, Error | PlatformError.PlatformError, StorageFs>;
  readonly pin: (
    input: string,
    pinned: boolean,
  ) => Effect.Effect<
    MemoryPinResult,
    Error | PlatformError.PlatformError,
    StorageFs
  >;
} = {
  folder: WORKSPACE_STORAGE_LAYOUT.memory,
  storagePath,
  list: Effect.suspend(() => loadMemoryItems()),
  preview: (input) =>
    storagePath(input).pipe(
      Effect.flatMap(loadMemoryPreview),
      Effect.map((loaded) => ({
        ...loaded,
        displayPath: toDisplayPath(loaded.storagePath),
      })),
    ),
  delete: (input) =>
    storagePath(input).pipe(
      Effect.flatMap((path) => deleteMemoryPath(path).pipe(onMemoryTreeLane)),
    ),
  pin: (input, pinned) =>
    storagePath(input).pipe(
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
