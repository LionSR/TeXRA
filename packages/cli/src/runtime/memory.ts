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

export function formatCliMemoryList(items: readonly MemoryViewItem[]): string {
  if (items.length === 0) {
    return 'No memory files found.';
  }

  const shown = items.slice(0, CLI_MEMORY_LIST_LIMIT);
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

function cliMemoryStoragePathFromInput(inputPath: string): string {
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

export interface CliMemoryDetail {
  readonly path: string;
  readonly lineCount?: number;
  readonly preview?: string;
}

/** Resolve a CLI memory path argument and load its preview exactly once. */
export async function loadCliMemoryDetail(
  inputPath: string,
): Promise<CliMemoryDetail> {
  const storagePath = cliMemoryStoragePathFromInput(inputPath);
  const preview = await loadMemoryPreview(storagePath);
  return {
    path: toDisplayPath(storagePath),
    lineCount: preview.lineCount,
    preview: preview.preview,
  };
}

export function formatCliMemoryPreview(detail: CliMemoryDetail): string {
  const lines = [`Memory: ${detail.path}`];
  if (detail.lineCount != null) {
    lines.push(`${detail.lineCount} lines`);
  }
  lines.push('', detail.preview?.trimEnd() || '(empty)');
  return lines.join('\n');
}
