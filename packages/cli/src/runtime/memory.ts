import type { MemoryViewItem } from '@shared/schemas';
import { normalizeFilePath } from '@shared/utils/path';
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/constants';
import { loadMemoryPreview } from '@tools/memory/memoryFileSystem';
import {
  displayToStoragePath,
  formatSize,
  resolveMemoryStoragePath,
  toDisplayPath,
} from '@tools/memory/memoryUtils';
import { truncateSummary } from '@utils/text/stringUtils';

export const CLI_MEMORY_LIST_LIMIT = 50;
const MEMORY_DESCRIPTION_MAX = 72;

function parseIsoTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatModifiedDate(value: string): string {
  const timestamp = parseIsoTimestamp(value);
  if (timestamp == null) return 'modified: unknown';
  return `modified: ${new Date(timestamp).toLocaleString()}`;
}

export function cliMemoryItemDescription(item: MemoryViewItem): string {
  const parts = [
    item.pinned ? 'pinned' : undefined,
    formatSize(item.size),
    formatModifiedDate(item.mtime),
    item.modifiedBy ? `by ${item.modifiedBy}` : undefined,
  ].filter((part): part is string => part != null);
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

export function resolveCliMemoryStoragePath(inputPath: string): string {
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
  if (trimmed.startsWith('memories/')) {
    return resolveMemoryStoragePath(trimmed);
  }
  return displayToStoragePath(`${MEMORY_DISPLAY_ROOT}/${trimmed}`);
}

export async function formatCliMemoryPreview(
  inputPath: string,
): Promise<string> {
  const storagePath = resolveCliMemoryStoragePath(inputPath);
  const preview = await loadMemoryPreview(storagePath);
  const displayPath = toDisplayPath(storagePath);
  const lines = [`Memory: ${displayPath}`];
  if (preview.lineCount != null) {
    lines.push(`${preview.lineCount} lines`);
  }
  lines.push('', preview.preview?.trimEnd() || '(empty)');
  return lines.join('\n');
}
