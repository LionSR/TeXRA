/**
 * Memory filesystem utilities shared by host surfaces.
 *
 * Provides functions to walk the memory storage directory and build
 * preview data for memory items displayed in views or terminal UI.
 */

import * as path from 'path';

import pMap from 'p-map';

import { isDirectory, isSymlink } from '@common/files/fsEntryType';
import type { MemoryPreview, MemoryViewItem } from '@shared/schemas';
import {
  MEMORY_STORAGE_ROOT,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  shouldSkipEntry,
} from '@tools/memory/constants';
import { relativeToDisplayPath } from '@tools/memory/memoryUtils';
import { parseFrontmatter, formatAttribution } from '@tools/memory/memoryMeta';
import { StorageFS } from '@utils/files';
import {
  normalizeLineEndings,
  splitContentLines,
} from '@utils/text/stringUtils';

const FRONTMATTER_SCAN_BYTES = 16 * 1024;
const PREVIEW_SCAN_BYTES = 64 * 1024;
const MEMORY_LISTING_CONCURRENCY = 8;

interface DirectoryToWalk {
  storagePath: string;
  relativeRoot: string;
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
export function buildPreview(
  content: string,
  options?: { truncated?: boolean; exactLineCount?: boolean },
): {
  preview: string;
  lineCount?: number;
} {
  const lines = splitContentLines(content);
  const exactLineCount = options?.exactLineCount ?? true;
  const lineCount = exactLineCount ? lines.length : undefined;
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
  let preview = previewLines.join('\n');
  let truncated =
    lines.length > MAX_PREVIEW_LINES || (options?.truncated ?? false);

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
  const { text: raw } = await readStoragePrefix(
    storagePath,
    FRONTMATTER_SCAN_BYTES,
    stats,
  );
  return parseFrontmatter(raw).meta;
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

/**
 * Walks the memory directory and collects all memory items.
 * @param storagePath - Current directory path to walk
 * @param relativeRoot - Path relative to MEMORY_STORAGE_ROOT for display
 * @returns Array of memory items found in the directory
 */
export async function walkMemoryDirectory(
  storagePath: string,
  relativeRoot = '',
): Promise<MemoryViewItem[]> {
  const items: MemoryViewItem[] = [];
  const pendingDirectories: DirectoryToWalk[] = [{ storagePath, relativeRoot }];

  for (let index = 0; index < pendingDirectories.length; index++) {
    const directory = pendingDirectories[index];
    const entries = await StorageFS.readDir(directory.storagePath);

    const results = await pMap(
      entries,
      async ([name, type]): Promise<{
        item?: MemoryViewItem;
        directory?: DirectoryToWalk;
      } | null> => {
        if (shouldSkipEntry(name)) {
          return null;
        }

        // Skip symlinks to avoid cycles; we have no realpath/visited guard.
        if (isSymlink(type)) {
          return null;
        }

        const nextRelative = directory.relativeRoot
          ? path.join(directory.relativeRoot, name)
          : name;
        const nextStoragePath = path.join(MEMORY_STORAGE_ROOT, nextRelative);

        if (isDirectory(type)) {
          return {
            directory: {
              storagePath: nextStoragePath,
              relativeRoot: nextRelative,
            },
          };
        }

        const stats = await StorageFS.stat(nextStoragePath);
        const meta = await readMemoryMeta(nextStoragePath, stats);
        const displayPath = relativeToDisplayPath(nextRelative);

        return {
          item: {
            displayPath,
            storagePath: nextStoragePath,
            size: stats.size,
            mtime: new Date(stats.mtime).toISOString(),
            modifiedBy: meta ? formatAttribution(meta) : undefined,
            pinned: meta?.pinned,
          },
        };
      },
      { concurrency: MEMORY_LISTING_CONCURRENCY },
    );

    for (const result of results) {
      if (result?.directory) {
        pendingDirectories.push(result.directory);
      }
      if (result?.item) {
        items.push(result.item);
      }
    }
  }

  return items;
}

/**
 * Loads all memory items from the storage root, sorted by modification time.
 * @returns Array of memory items, newest first
 */
export async function loadMemoryItems(): Promise<MemoryViewItem[]> {
  const exists = await StorageFS.exists(MEMORY_STORAGE_ROOT);
  if (!exists) {
    return [];
  }

  const items = await walkMemoryDirectory(MEMORY_STORAGE_ROOT);
  return items.sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return b.mtime.localeCompare(a.mtime);
  });
}
