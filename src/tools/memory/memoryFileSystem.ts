/**
 * Memory filesystem utilities shared by host surfaces.
 *
 * Provides functions to walk the memory storage directory and build
 * preview data for memory items displayed in views or terminal UI.
 */

import * as path from 'node:path';

import { Data, Effect, Semaphore, Stream } from 'effect';

import { debug } from '@logger/logUtils';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { MemoryPreview, MemoryViewItem } from '@shared/schemas';
import {
  MAX_PINNED_MEMORIES,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  shouldSkipEntry,
} from '@tools/memory/constants';
import { relativeToDisplayPath } from '@tools/memory/memoryUtils';
import {
  buildFile,
  parseFrontmatter,
  formatAttribution,
  setPinnedMeta,
  type MemoryFileMeta,
} from '@tools/memory/memoryMeta';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory, isSymlink } from '@utils/files/fsEntryType';
import {
  normalizeLineEndings,
  splitContentLines,
} from '@utils/text/stringUtils';

const FRONTMATTER_SCAN_BYTES = 16 * 1024;
const PREVIEW_SCAN_BYTES = 64 * 1024;
const MEMORY_LISTING_CONCURRENCY = 8;

/** Options controlling how far and how much {@link walkMemoryDirectory} descends. */
export interface MemoryWalkOptions {
  /** Number of levels below the walk root to include. Unlimited when omitted. */
  maxDepth?: number;
  /** Include directory entries themselves in the yielded results. */
  includeDirs?: boolean;
}

/** One filesystem entry discovered while walking the memory tree. */
export interface MemoryWalkEntry {
  /** Path relative to the walk root (matches the `relativeRoot` passed in). */
  relativePath: string;
  storagePath: string;
  size: number;
  mtime: number;
  isDir: boolean;
  /** Frontmatter metadata for files; always null for directories. */
  meta: MemoryFileMeta | null;
}

async function readStoragePrefix(
  storagePath: string,
  maxBytes: number,
  stats?: { size: number },
): Promise<{ text: string; truncated: boolean }> {
  const fileStats = stats ?? (await StorageFS.stat(storagePath));
  if (fileStats.size === 0) {
    return { text: '', truncated: false };
  }

  const chunks: Buffer[] = [];
  const end = Math.min(maxBytes, fileStats.size) - 1;
  for await (const chunk of StorageFS.createReadStream(storagePath, {
    start: 0,
    end,
  })) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    text: normalizeLineEndings(Buffer.concat(chunks).toString('utf-8')),
    truncated: fileStats.size > maxBytes,
  };
}

/**
 * The frontmatter head of a memory file could not be read or parsed (race
 * deletion, permission error). Attribution is skipped rather than failing
 * the whole walk; the entry itself still lists.
 */
class MemoryMetaUnreadable extends Data.TaggedError('MemoryMetaUnreadable')<{
  readonly storagePath: string;
  readonly cause: unknown;
}> {}

const readMemoryMeta = Effect.fn('memoryFileSystem.readMemoryMeta')(
  (storagePath: string, stats: { size: number }) =>
    Effect.tryPromise({
      try: async () => {
        const { text: raw } = await readStoragePrefix(
          storagePath,
          FRONTMATTER_SCAN_BYTES,
          stats,
        );
        return parseFrontmatter(raw).meta;
      },
      catch: (cause) => new MemoryMetaUnreadable({ storagePath, cause }),
    }).pipe(
      Effect.catchTag('MemoryMetaUnreadable', (error) =>
        Effect.sync(() => {
          debug(
            'memory',
            `Skipping attribution for unreadable memory file ${error.storagePath}`,
            { data: error.cause },
          );
          return null;
        }),
      ),
    ),
);

/**
 * Read the head of a memory file and project it into the bounded preview the
 * settings view and the CLI show: at most {@link MAX_PREVIEW_LINES} lines and
 * {@link MAX_PREVIEW_CHARS} characters, with a trailing `...` whenever
 * anything was left out. `lineCount` is reported only when the whole file fit
 * inside the scan window, since a partial read cannot count the rest.
 */
export async function loadMemoryPreview(
  storagePath: string,
): Promise<MemoryPreview> {
  const { text: raw, truncated: scanTruncated } = await readStoragePrefix(
    storagePath,
    PREVIEW_SCAN_BYTES,
  );
  const { content } = parseFrontmatter(raw);

  const lines = splitContentLines(content);
  const lineCount = scanTruncated ? undefined : lines.length;
  let preview = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
  let truncated = lines.length > MAX_PREVIEW_LINES || scanTruncated;

  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.slice(0, MAX_PREVIEW_CHARS);
    truncated = true;
  }

  if (truncated) {
    preview = `${preview}\n...`;
  }

  return { storagePath, preview, lineCount };
}

/** Stat one directory entry and, for a file, read its attribution head. */
const describeEntry = Effect.fn('memoryFileSystem.describeEntry')(function* (
  storagePath: string,
  relativePath: string,
  type: number,
) {
  const stats = yield* Effect.promise(() => StorageFS.stat(storagePath));
  const entry = {
    relativePath,
    storagePath,
    size: stats.size,
    mtime: stats.mtime,
  };
  if (isDirectory(type)) {
    return { ...entry, isDir: true, meta: null } satisfies MemoryWalkEntry;
  }
  const meta = yield* readMemoryMeta(storagePath, stats);
  return { ...entry, isDir: false, meta } satisfies MemoryWalkEntry;
});

/**
 * One directory level of the walk. Entries are described in listing order
 * with at most {@link MEMORY_LISTING_CONCURRENCY} in flight per level, and
 * `permits` bounds the metadata reads across every level of the recursion
 * so a deep tree cannot multiply that bound.
 */
function walkLevel(
  storagePath: string,
  relativeRoot: string,
  depth: number,
  options: MemoryWalkOptions,
  permits: Semaphore.Semaphore,
): Stream.Stream<MemoryWalkEntry> {
  return Stream.fromEffect(
    Effect.promise(() => StorageFS.readDir(storagePath)),
  ).pipe(
    Stream.flatMap(Stream.fromIterable),
    // Skip symlinks to avoid cycles; we have no realpath/visited guard.
    Stream.filter(([name, type]) => !shouldSkipEntry(name) && !isSymlink(type)),
    Stream.mapEffect(
      ([name, type]) =>
        permits.withPermits(1)(
          describeEntry(
            path.join(storagePath, name),
            relativeRoot ? path.join(relativeRoot, name) : name,
            type,
          ),
        ),
      { concurrency: MEMORY_LISTING_CONCURRENCY },
    ),
    Stream.flatMap((entry) => {
      if (!entry.isDir) return Stream.make(entry);
      const self = options.includeDirs ? Stream.make(entry) : Stream.empty;
      const descend =
        options.maxDepth === undefined || depth + 1 < options.maxDepth;
      return descend
        ? Stream.concat(
            self,
            walkLevel(
              entry.storagePath,
              entry.relativePath,
              depth + 1,
              options,
              permits,
            ),
          )
        : self;
    }),
  );
}

/**
 * Walks the memory directory tree in depth-first order, skipping dotfiles,
 * `node_modules`, and symlinks (no realpath/visited guard, so a symlink is
 * never followed rather than risking a cycle). Breaking out of the iteration
 * early interrupts the walk, so no further entries are read.
 * @param storagePath - Directory to start walking from
 * @param relativeRoot - Path prefix used to build each entry's relativePath
 * @param options - `maxDepth` (levels below the root; unlimited if omitted)
 *   and `includeDirs` (whether directory entries themselves are yielded)
 */
export async function* walkMemoryDirectory(
  storagePath: string,
  relativeRoot = '',
  options: MemoryWalkOptions = {},
): AsyncGenerator<MemoryWalkEntry> {
  yield* Stream.toAsyncIterable(
    Stream.unwrap(
      Effect.map(Semaphore.make(MEMORY_LISTING_CONCURRENCY), (permits) =>
        walkLevel(storagePath, relativeRoot, 0, options, permits),
      ),
    ),
  );
}

/**
 * Loads all memory items from the storage root, sorted by modification time.
 * @returns Array of memory items, newest first
 */
export async function loadMemoryItems(): Promise<MemoryViewItem[]> {
  const exists = await StorageFS.exists(MEMORY_STORAGE_DIR);
  if (!exists) {
    return [];
  }

  const items: MemoryViewItem[] = [];
  for await (const entry of walkMemoryDirectory(MEMORY_STORAGE_DIR)) {
    items.push({
      displayPath: relativeToDisplayPath(entry.relativePath),
      storagePath: entry.storagePath,
      size: entry.size,
      mtime: new Date(entry.mtime).toISOString(),
      modifiedBy: entry.meta ? formatAttribution(entry.meta) : undefined,
      pinned: entry.meta?.pinned,
    });
  }
  return items.toSorted(
    (a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.mtime.localeCompare(a.mtime),
  );
}

/**
 * Count pinned memory files under MEMORY_STORAGE_DIR.
 * Short-circuits once `limit` is reached to avoid unnecessary reads.
 * Returns 0 if the storage root does not exist.
 */
export async function countPinnedMemories(limit?: number): Promise<number> {
  const exists = await StorageFS.exists(MEMORY_STORAGE_DIR);
  if (!exists) return 0;

  const cap = limit ?? Infinity;
  let count = 0;
  for await (const entry of walkMemoryDirectory(MEMORY_STORAGE_DIR)) {
    if (entry.meta?.pinned) count++;
    if (count >= cap) break;
  }
  return count;
}

export type SetMemoryPinnedResult =
  | { readonly status: 'changed'; readonly pinnedCount: number }
  | { readonly status: 'already' }
  | { readonly status: 'cap-reached' };

/**
 * Pin or unpin a memory file in place, the one mutation shared by the
 * MemoryTool `pin`/`unpin` commands and the settings-view pin toggle.
 * Reports 'already' when the file's pinned flag already matches the
 * requested state, 'cap-reached' when pinning would exceed
 * MAX_PINNED_MEMORIES, or 'changed' after writing the update. Each caller
 * formats its own surface message from the returned status.
 *
 * `pinnedCount` on a successful pin is the post-write total, derived from
 * the cap-check walk this function already performs. Callers must not walk
 * the tree again to display it: a second `countPinnedMemories()` without a
 * limit loses the early exit and rescans every file.
 */
export async function setMemoryPinned(
  storagePath: string,
  pinned: boolean,
): Promise<SetMemoryPinnedResult> {
  const raw = await StorageFS.read(storagePath);
  const { meta, content } = parseFrontmatter(raw);

  const alreadyInState = pinned ? !!meta?.pinned : !meta?.pinned;
  if (alreadyInState) return { status: 'already' };

  let pinnedCount = 0;
  if (pinned) {
    const priorPinned = await countPinnedMemories(MAX_PINNED_MEMORIES);
    if (priorPinned >= MAX_PINNED_MEMORIES) return { status: 'cap-reached' };
    pinnedCount = priorPinned + 1;
  }

  const updatedMeta = setPinnedMeta(meta, pinned);
  await StorageFS.writeAtomic(storagePath, buildFile(content, updatedMeta));
  return { status: 'changed', pinnedCount };
}
