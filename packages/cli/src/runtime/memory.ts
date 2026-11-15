import { Effect } from 'effect';

import { absentReason } from '@texra-ai/harness/node';
import { MemoryStore } from '@texra-ai/harness/plugins';
import {
  formatResultCount,
  type MemoryViewItem,
  truncateSummary,
} from '@texra-ai/harness/schemas';
import { memoryItemFacts } from '@ui/copy/memory';
import { moreRowsText } from '@cli/tui/overflowText';

export const CLI_MEMORY_LIST_LIMIT = 50;
const MEMORY_DESCRIPTION_MAX = 72;

export function cliMemoryItemDescription(item: MemoryViewItem): string {
  return truncateSummary(
    memoryItemFacts(item).join(' · '),
    MEMORY_DESCRIPTION_MAX,
  );
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
    lines.push(moreRowsText(items.length - shown.length));
  }
  return lines.join('\n');
}

interface CliMemoryDetail {
  readonly path: string;
  readonly lineCount?: number;
  readonly preview?: string;
}

/** Resolve a CLI memory path argument and load its preview exactly once. */
export const loadCliMemoryDetail = Effect.fn('cli.loadCliMemoryDetail')(
  function* (inputPath: string) {
    // A typed argument: its surrounding whitespace is not part of the name.
    const storagePath = yield* MemoryStore.storagePath(inputPath.trim());
    const preview = yield* MemoryStore.preview(storagePath).pipe(
      Effect.catchIf(absentReason, () =>
        Effect.fail(
          new Error(
            `No stored memory at ${MemoryStore.displayPath(storagePath)}; \`memory list\` shows the stored ones.`,
          ),
        ),
      ),
    );
    return {
      path: preview.displayPath,
      lineCount: preview.lineCount,
      preview: preview.preview,
    } satisfies CliMemoryDetail;
  },
);

export function formatCliMemoryPreview(detail: CliMemoryDetail): string {
  const lines = [`Memory: ${detail.path}`];
  if (detail.lineCount != null) {
    lines.push(formatResultCount(detail.lineCount, 'line'));
  }
  lines.push('', detail.preview?.trimEnd() || '(empty)');
  return lines.join('\n');
}
