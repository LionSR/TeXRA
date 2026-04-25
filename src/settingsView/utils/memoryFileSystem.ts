/**
 * Memory filesystem utilities for SettingsView.
 *
 * Provides functions to walk the memory storage directory and build
 * preview data for memory items displayed in the Memory tab.
 */

import * as path from 'path';

import { isDirectory, isSymlink } from '@common/files/fsEntryType';
import type { MemoryViewItem } from '@shared/schemas/settingsViewMessages';
import {
  MEMORY_STORAGE_ROOT,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  shouldSkipEntry,
} from '@tools/memory/constants';
import { relativeToDisplayPath } from '@tools/memory/memoryUtils';
import { parseFrontmatter, formatAttribution } from '@tools/memory/memoryMeta';
import { StorageFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

/**
 * Builds a preview of content with truncation info.
 * @param content - The full file content to preview
 * @returns Preview text and total line count
 */
export function buildPreview(content: string): {
  preview: string;
  lineCount: number;
} {
  const lines = splitContentLines(content);
  const lineCount = lines.length;
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
  let preview = previewLines.join('\n');
  let truncated = lineCount > MAX_PREVIEW_LINES;

  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.slice(0, MAX_PREVIEW_CHARS);
    truncated = true;
  }

  if (truncated) {
    preview = `${preview}\n...`;
  }

  return { preview, lineCount };
}

/**
 * Recursively walks the memory directory and collects all memory items.
 * @param storagePath - Current directory path to walk
 * @param relativeRoot - Path relative to MEMORY_STORAGE_ROOT (for display)
 * @returns Array of memory items found in the directory
 */
export async function walkMemoryDirectory(
  storagePath: string,
  relativeRoot = '',
): Promise<MemoryViewItem[]> {
  const entries = await StorageFS.readDir(storagePath);
  const results: MemoryViewItem[] = [];

  for (const [name, type] of entries) {
    if (shouldSkipEntry(name)) {
      continue;
    }

    // Skip symlinks to avoid cycles; we have no realpath/visited guard.
    if (isSymlink(type)) {
      continue;
    }

    const nextRelative = relativeRoot ? path.join(relativeRoot, name) : name;
    const nextStoragePath = path.join(MEMORY_STORAGE_ROOT, nextRelative);

    if (isDirectory(type)) {
      results.push(
        ...(await walkMemoryDirectory(nextStoragePath, nextRelative)),
      );
      continue;
    }

    const stats = await StorageFS.stat(nextStoragePath);
    const raw = await StorageFS.read(nextStoragePath);
    const { meta, content } = parseFrontmatter(raw);
    const previewData = buildPreview(content);
    const displayPath = relativeToDisplayPath(nextRelative);

    results.push({
      displayPath,
      storagePath: nextStoragePath,
      size: stats.size,
      mtime: new Date(stats.mtime).toISOString(),
      lineCount: previewData.lineCount,
      preview: previewData.preview,
      modifiedBy: meta ? formatAttribution(meta) : undefined,
      pinned: meta?.pinned,
    });
  }

  return results;
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
    // Pinned items first
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    // Then by modification time (newest first)
    return b.mtime.localeCompare(a.mtime);
  });
}
