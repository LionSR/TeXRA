/**
 * Memory filesystem utilities shared by host surfaces.
 *
 * Provides functions to walk the memory storage directory and build
 * preview data for memory items displayed in views or terminal UI.
 */

import * as path from 'node:path';

import { pMapIterable, pMapSkip } from 'p-map';
import PQueue from 'p-queue';

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
 * Builds a preview of content with truncation info.
 * @param content - The full file content to preview
 * @returns Preview text and line count when the caller supplied complete content
 */
function buildPreview(
  content: string,
  options: { truncated: boolean; exactLineCount: boolean },
): {
  preview: string;
  lineCount?: number;
} {
  const lines = splitContentLines(content);
  const lineCount = options.exactLineCount ? lines.length : undefined;
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
  let preview = previewLines.join('\n');
  let truncated = lines.length > MAX_PREVIEW_LINES || options.truncated;

  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.slice(0, MAX_PREVIEW_CHARS);
    truncated = true;
  }

  if (truncated) {
    preview = `${preview}\n...`;
  }

  return { preview, lineCount };
}

async function readMemoryMeta(storagePath: string, stats: { size: number }) {
  try {
    const { text: raw } = await readStoragePrefix(
      storagePath,
      FRONTMATTER_SCAN_BYTES,
      stats,
    );
    return parseFrontmatter(raw).meta;
  } catch (error) {
    // Unreadable file (race deletion, permission error) — skip attribution
    // rather than failing the whole walk; the entry itself still lists.
    debug(
      'memory',
      `Skipping attribution for unreadable memory file ${storagePath}`,
      { data: error },
    );
    return null;
  }
}

export async function loadMemoryPreview(
  storagePath: string,
): Promise<MemoryPreview> {
  const { text: raw, truncated } = await readStoragePrefix(
    storagePath,
    PREVIEW_SCAN_BYTES,
  );
  const { content } = parseFrontmatter(raw);
  return {
    storagePath,
    ...buildPreview(content, { truncated, exactLineCount: !truncated }),
  };
}

async function* walkDir(
  storagePath: string,
  relativeRoot: string,
  depth: number,
  options: MemoryWalkOptions,
  queue: PQueue,
): AsyncGenerator<MemoryWalkEntry> {
  const entries = await StorageFS.readDir(storagePath);

  const results = pMapIterable(
    entries,
    async ([name, type]): Promise<MemoryWalkEntry | typeof pMapSkip> => {
      if (shouldSkipEntry(name)) {
        return pMapSkip;
      }

      // Skip symlinks to avoid cycles; we have no realpath/visited guard.
      if (isSymlink(type)) {
        return pMapSkip;
      }

      return queue.add(async () => {
        const nextRelative = relativeRoot
          ? path.join(relativeRoot, name)
          : name;
        const nextStoragePath = path.join(storagePath, name);
        const stats = await StorageFS.stat(nextStoragePath);

        if (isDirectory(type)) {
          return {
            relativePath: nextRelative,
            storagePath: nextStoragePath,
            size: stats.size,
            mtime: stats.mtime,
            isDir: true,
            meta: null,
          };
        }

        const meta = await readMemoryMeta(nextStoragePath, stats);
        return {
          relativePath: nextRelative,
          storagePath: nextStoragePath,
          size: stats.size,
          mtime: stats.mtime,
          isDir: false,
          meta,
        };
      }) as Promise<MemoryWalkEntry>;
    },
    { concurrency: MEMORY_LISTING_CONCURRENCY },
  );

  for await (const entry of results) {
    if (entry.isDir) {
      if (options.includeDirs) {
        yield entry;
      }
      if (options.maxDepth === undefined || depth + 1 < options.maxDepth) {
        yield* walkDir(
          entry.storagePath,
          entry.relativePath,
          depth + 1,
          options,
          queue,
        );
      }
    } else {
      yield entry;
    }
  }
}

/**
 * Walks the memory directory tree in depth-first order, skipping dotfiles,
 * `node_modules`, and symlinks (no realpath/visited guard, so a symlink is
 * never followed rather than risking a cycle).
 * @param storagePath - Directory to start walking from
 * @param relativeRoot - Path prefix used to build each entry's relativePath
 * @param options - `maxDepth` (levels below the root; unlimited if omitted)
 *   and `includeDirs` (whether directory entries themselves are yielded)
 */
export function walkMemoryDirectory(
  storagePath: string,
  relativeRoot = '',
  options: MemoryWalkOptions = {},
): AsyncGenerator<MemoryWalkEntry> {
  return walkDir(
    storagePath,
    relativeRoot,
    0,
    options,
    new PQueue({ concurrency: MEMORY_LISTING_CONCURRENCY }),
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
