import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import type { MemoryViewItem } from '@shared/schemas';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { loadMemoryPreview } from '@tools/memory/memoryFileSystem';
import { displayToStoragePath, toDisplayPath } from '@tools/memory/memoryUtils';
import { filterNotNullish, normalizeFilePath } from '@utils/core';
import {
  formatBytes,
  formatLocaleTimestamp,
  truncateSummary,
} from '@utils/text/stringUtils';

export const CLI_MEMORY_LIST_LIMIT = 50;
const MEMORY_DESCRIPTION_MAX = 72;

function formatModifiedDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'modified: unknown';
  return `modified: ${formatLocaleTimestamp(timestamp)}`;
}

export function cliMemoryItemDescription(item: MemoryViewItem): string {
  const parts = [
    item.pinned ? 'pinned' : undefined,
    formatBytes(item.size),
    formatModifiedDate(item.mtime),
    item.modifiedBy ? `by ${item.modifiedBy}` : undefined,
  ].filter(filterNotNullish);
  return truncateSummary(parts.join('; '), MEMORY_DESCRIPTION_MAX);
}

export function formatCliMemoryList(
  items: readonly MemoryViewItem[],
  options?: { limit?: number },
): string {
  if (items.length === 0) {
    return 'No memory files found.';
  }

  const limit = options?.limit ?? CLI_MEMORY_LIST_LIMIT;
  const shown = items.slice(0, limit);
  const lines = [
    `Memories (${items.length}):`,
    ...shown.map(
      (item) => `${item.displayPath}\t${cliMemoryItemDescription(item)}`,
    ),
  ];
  if (items.length > shown.length) {
    lines.push(`... ${items.length - shown.length} more`);
  }
  return lines.join('\n');
}

export function cliMemoryStoragePathFromInput(inputPath: string): string {
  const trimmed = normalizeFilePath(inputPath.trim());
  if (!trimmed) {
    return displayToStoragePath(MEMORY_DISPLAY_ROOT);
  }
  if (
    trimmed === MEMORY_DISPLAY_ROOT ||
    trimmed.startsWith(`${MEMORY_DISPLAY_ROOT}/`)
  ) {
    return displayToStoragePath(trimmed);
  }
  if (trimmed.startsWith('/')) {
    throw new Error(
      `Invalid memory path "${trimmed}". Use /memories, /memories/<file>, memories/<file>, or a relative memory filename.`,
    );
  }
  if (/^[A-Za-z]:\//.test(trimmed)) {
    throw new Error(
      `Invalid memory path "${trimmed}". Memory paths must be relative to ${MEMORY_DISPLAY_ROOT}.`,
    );
  }
  if (trimmed.startsWith(`${resolveMemoryStoragePath()}/`)) {
    return resolveMemoryStoragePath(trimmed);
  }
  return displayToStoragePath(`${MEMORY_DISPLAY_ROOT}/${trimmed}`);
}

export async function formatCliMemoryPreview(
  inputPath: string,
): Promise<string> {
  const storagePath = cliMemoryStoragePathFromInput(inputPath);
  const preview = await loadMemoryPreview(storagePath);
  const displayPath = toDisplayPath(storagePath);
  const lines = [`Memory: ${displayPath}`];
  if (preview.lineCount != null) {
    lines.push(`${preview.lineCount} lines`);
  }
  lines.push('', preview.preview?.trimEnd() || '(empty)');
  return lines.join('\n');
}
