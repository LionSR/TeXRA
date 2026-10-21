import { Effect, PlatformError, Predicate } from 'effect';

import { withSessionFs, type StorageFs } from '@texra-ai/harness';
import { MemoryStore, type MemoryViewItem } from '@texra-ai/harness/plugins';
import { truncateSummary } from '@texra-ai/harness/schemas';
import { formatBytes } from '@utils/text/stringUtils';
import type { WorkspaceRoots } from '@texra-ai/harness';

export const CLI_MEMORY_LIST_LIMIT = 50;
const MEMORY_DESCRIPTION_MAX = 72;

function formatModifiedDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'modified: unknown';
  return `modified: ${new Date(timestamp).toLocaleString()}`;
}

export function cliMemoryItemDescription(item: MemoryViewItem): string {
  const parts = [
    item.pinned ? 'pinned' : undefined,
    formatBytes(item.size),
    formatModifiedDate(item.mtime),
    item.modifiedBy ? `by ${item.modifiedBy}` : undefined,
  ].filter(Predicate.isNotNullish);
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

export interface CliMemoryDetail {
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
      Effect.catchIf(
        (error) =>
          PlatformError.isPlatformError(error) &&
          error.reason._tag === 'NotFound',
        () =>
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

/**
 * A memory program over the storage view of the roots its calling surface
 * holds — the root is chosen here rather than read inside the program. The
 * command action, the slash-command handler, and the list form each run the
 * returned program once, on the runtime their surface already holds. An
 * unreadable memory ends the command with the error the filesystem raised;
 * the CLI's error reporter prints that message.
 */
export function runCliMemory<A>(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage' | 'globalStorage'>,
  program: Effect.Effect<A, Error, StorageFs>,
) {
  return withSessionFs(roots, Effect.orDie(program));
}

export function formatCliMemoryPreview(detail: CliMemoryDetail): string {
  const lines = [`Memory: ${detail.path}`];
  if (detail.lineCount != null) {
    lines.push(`${detail.lineCount} lines`);
  }
  lines.push('', detail.preview?.trimEnd() || '(empty)');
  return lines.join('\n');
}
