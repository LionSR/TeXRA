/**
 * Memory filesystem utilities shared by host surfaces.
 *
 * Every read and write of the memory tree is an Effect program over the
 * session's {@link StorageFs} — the rooted view that captured its storage
 * root when its layer was built — and the walk is a `Stream`: the callers
 * (the memory tool, the settings controller, the CLI) compose them into their
 * own programs and run once at their host or tool edge, which is where the
 * root is chosen. Filesystem failures are the standard library's
 * `PlatformError`, so a caller matches `reason._tag` exactly as it would for
 * any other file it reads.
 */

import { Buffer } from 'node:buffer';
import * as path from 'node:path';

import {
  Effect,
  type FileSystem,
  Option,
  type PlatformError,
  Semaphore,
  Stream,
} from 'effect';

import { withLogChannel, withLogData } from '@logger/effectLog';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { StorageFs } from '@platform/rootedFs';
import type { MemoryViewItem } from '@shared/schemas';
import {
  MAX_PINNED_MEMORIES,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
} from '@tools/memory/constants';
import { relativeToDisplayPath } from '@tools/memory/memoryUtils';
import {
  buildFile,
  parseFrontmatter,
  formatAttribution,
  setPinnedMeta,
  type MemoryFileMeta,
} from '@tools/memory/memoryMeta';
import { pathExists, readNormalizedFile } from '@utils/files/fsDurability';
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

/**
 * Does a memory path exist? The one existence probe every caller shares.
 *
 * `pathExists` follows a symlink, where the facade's `lstat`-backed probe
 * reported a dangling link as present. The walk below never yields a
 * symlink, so the only paths reaching here are ones a caller named itself.
 */
export const memoryPathExists = Effect.fn('memoryFileSystem.memoryPathExists')(
  function* (storagePath: string) {
    return yield* pathExists(yield* StorageFs, storagePath);
  },
);

/** Stat one memory path. The one `stat` the tree shares. */
export const statMemoryEntry = Effect.fn('memoryFileSystem.statMemoryEntry')(
  function* (storagePath: string) {
    return yield* (yield* StorageFs).stat(storagePath);
  },
);

/** Read one memory file whole and split its frontmatter from its content. */
export const readMemoryFile = Effect.fn('memoryFileSystem.readMemoryFile')(
  function* (storagePath: string) {
    return parseFrontmatter(
      yield* readNormalizedFile(yield* StorageFs, storagePath),
    );
  },
);

/** Write one memory file atomically, frontmatter first. */
export const writeMemoryFile = Effect.fn('memoryFileSystem.writeMemoryFile')(
  function* (
    storagePath: string,
    content: string,
    meta: MemoryFileMeta | null,
  ) {
    yield* (yield* StorageFs).writeFileAtomic(
      storagePath,
      Buffer.from(buildFile(content, meta), 'utf-8'),
    );
  },
);

/** Delete one memory path and everything under it. */
export const deleteMemoryPath = Effect.fn('memoryFileSystem.deleteMemoryPath')(
  function* (storagePath: string) {
    yield* (yield* StorageFs).remove(storagePath, { recursive: true });
  },
);

/** Rename one memory path inside the session's storage root. */
export const renameMemoryPath = Effect.fn('memoryFileSystem.renameMemoryPath')(
  function* (source: string, destination: string) {
    yield* (yield* StorageFs).rename(source, destination);
  },
);

/** Read at most `maxBytes` from the head of a memory file. */
const readStoragePrefix = Effect.fn('memoryFileSystem.readStoragePrefix')(
  function* (storagePath: string, maxBytes: number, stats?: { size: number }) {
    const storageFs = yield* StorageFs;
    const size =
      stats?.size ?? Number((yield* storageFs.stat(storagePath)).size);
    if (size === 0) {
      return { text: '', truncated: false };
    }
    const chunks = yield* Stream.runCollect(
      storageFs.stream(storagePath, { bytesToRead: Math.min(maxBytes, size) }),
    );
    const text = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
    ).toString('utf-8');
    return {
      text: normalizeLineEndings(text),
      truncated: size > maxBytes,
    };
  },
);

/**
 * The frontmatter head of a memory file, or `null`.
 *
 * An entry lists without attribution when its head cannot be read or parsed
 * (a race deletion or permission error between the stat and the head read, a
 * truncated head). Skipping is the whole recovery: the walk continues and the
 * entry still appears, with the reason on the debug channel.
 */
const CHANNEL = 'memory';

const readMemoryMeta = Effect.fn('memoryFileSystem.readMemoryMeta')(
  (storagePath: string, stats: { size: number }) =>
    readStoragePrefix(storagePath, FRONTMATTER_SCAN_BYTES, stats).pipe(
      Effect.flatMap(({ text }) =>
        Effect.try({
          try: () => parseFrontmatter(text).meta,
          catch: (cause) => cause,
        }),
      ),
      Effect.catch((cause) =>
        Effect.logDebug(
          `Skipping attribution for unreadable memory file ${storagePath}`,
        ).pipe(withLogChannel(CHANNEL), withLogData(cause), Effect.as(null)),
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
export const loadMemoryPreview = Effect.fn(
  'memoryFileSystem.loadMemoryPreview',
)(function* (storagePath: string) {
  const { text: raw, truncated: scanTruncated } = yield* readStoragePrefix(
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
});

/** Stat one directory entry and, for a file, read its attribution head. */
const describeEntry = Effect.fn('memoryFileSystem.describeEntry')(function* (
  storagePath: string,
  relativePath: string,
  type: FileSystem.File.Type,
) {
  const stats = yield* statMemoryEntry(storagePath);
  const size = Number(stats.size);
  const entry = {
    relativePath,
    storagePath,
    size,
    mtime: Option.getOrUndefined(stats.mtime)?.getTime() ?? 0,
  };
  if (type === 'Directory') {
    return { ...entry, isDir: true, meta: null } satisfies MemoryWalkEntry;
  }
  const meta = yield* readMemoryMeta(storagePath, { size });
  return { ...entry, isDir: false, meta } satisfies MemoryWalkEntry;
});

/**
 * The memory tree's own ignore rule: dotted entries and dependency
 * directories are not part of it.
 */
function shouldSkipEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

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
): Stream.Stream<MemoryWalkEntry, PlatformError.PlatformError, StorageFs> {
  return Stream.fromIterableEffect(
    Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
      storageFs.readDirectoryTyped(storagePath),
    ),
  ).pipe(
    // Skip symlinks to avoid cycles; we have no realpath/visited guard.
    Stream.filter(
      ([name, type]) => !shouldSkipEntry(name) && type !== 'SymbolicLink',
    ),
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
 * The memory directory tree in depth-first order, skipping dotfiles,
 * `node_modules`, and symlinks (no realpath/visited guard, so a symlink is
 * never followed rather than risking a cycle). A consumer that takes a
 * bounded prefix (`Stream.take`) interrupts the walk, so no further entries
 * are read. An unreadable directory or entry fails the stream with the
 * `PlatformError` the filesystem raised.
 * @param storagePath - Directory to start walking from
 * @param relativeRoot - Path prefix used to build each entry's relativePath
 * @param options - `maxDepth` (levels below the root; unlimited if omitted)
 *   and `includeDirs` (whether directory entries themselves are yielded)
 */
export function walkMemoryDirectory(
  storagePath: string,
  relativeRoot = '',
  options: MemoryWalkOptions = {},
): Stream.Stream<MemoryWalkEntry, PlatformError.PlatformError, StorageFs> {
  return Stream.unwrap(
    Effect.map(Semaphore.make(MEMORY_LISTING_CONCURRENCY), (permits) =>
      walkLevel(storagePath, relativeRoot, 0, options, permits),
    ),
  );
}

/**
 * All memory items under the storage root, sorted pinned-first then by
 * modification time, newest first. Empty when the root does not exist.
 */
export const loadMemoryItems = Effect.fn('memoryFileSystem.loadMemoryItems')(
  function* () {
    const exists = yield* memoryPathExists(MEMORY_STORAGE_DIR);
    if (!exists) return [];

    const entries = yield* Stream.runCollect(
      walkMemoryDirectory(MEMORY_STORAGE_DIR),
    );
    const items = entries.map((entry): MemoryViewItem => ({
      displayPath: relativeToDisplayPath(entry.relativePath),
      storagePath: entry.storagePath,
      size: entry.size,
      mtime: new Date(entry.mtime).toISOString(),
      modifiedBy: entry.meta ? formatAttribution(entry.meta) : undefined,
      pinned: entry.meta?.pinned,
    }));
    return items.toSorted(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        b.mtime.localeCompare(a.mtime),
    );
  },
);

/**
 * Count pinned memory files under MEMORY_STORAGE_DIR. `limit` bounds the
 * walk — the stream is interrupted once that many pinned files are seen, so
 * the remaining metadata reads never happen. Returns 0 if the storage root
 * does not exist.
 */
export const countPinnedMemories = Effect.fn(
  'memoryFileSystem.countPinnedMemories',
)(function* (limit?: number) {
  const exists = yield* memoryPathExists(MEMORY_STORAGE_DIR);
  if (!exists) return 0;

  const pinned = walkMemoryDirectory(MEMORY_STORAGE_DIR).pipe(
    Stream.filter((entry) => entry.meta?.pinned === true),
  );
  return yield* Stream.runCount(
    limit === undefined ? pinned : Stream.take(pinned, limit),
  );
});

/**
 * What one pin/unpin attempt did. Module-local: every caller reads the
 * `status` discriminant off the returned value and formats its own surface
 * message, so nothing imports the name.
 */
type SetMemoryPinnedResult =
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
export const setMemoryPinned = Effect.fn('memoryFileSystem.setMemoryPinned')(
  function* (storagePath: string, pinned: boolean) {
    const { meta, content } = yield* readMemoryFile(storagePath);

    const alreadyInState = pinned ? !!meta?.pinned : !meta?.pinned;
    if (alreadyInState) {
      return { status: 'already' } satisfies SetMemoryPinnedResult;
    }

    let pinnedCount = 0;
    if (pinned) {
      const priorPinned = yield* countPinnedMemories(MAX_PINNED_MEMORIES);
      if (priorPinned >= MAX_PINNED_MEMORIES) {
        return { status: 'cap-reached' } satisfies SetMemoryPinnedResult;
      }
      pinnedCount = priorPinned + 1;
    }

    yield* writeMemoryFile(storagePath, content, setPinnedMeta(meta, pinned));
    return { status: 'changed', pinnedCount } satisfies SetMemoryPinnedResult;
  },
);
