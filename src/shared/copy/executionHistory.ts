import { formatResultCount } from '@utils/text/stringUtils';

/** Joins non-empty parts (in order) with "and", dropping undefined slots. */
function joinCountedParts(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .filter((part): part is string => part !== undefined)
    .join(' and ');
}

export function formatExecutionHistoryRetention(
  activeCount: number,
  failedCount: number,
): string {
  const retained = joinCountedParts([
    activeCount > 0
      ? formatResultCount(activeCount, 'active execution')
      : undefined,
    failedCount > 0
      ? formatResultCount(
          failedCount,
          'execution that could not be removed',
          'executions that could not be removed',
        )
      : undefined,
  ]);
  return `Cleared stored history except for ${retained}.`;
}

export function formatCliHistoryDeletionSummary(counts: {
  readonly deleted: number;
  readonly active: number;
  readonly failed: number;
}): string {
  const sentences = [
    `Deleted ${formatResultCount(counts.deleted, 'stored execution')}.`,
  ];
  if (counts.active > 0) {
    sentences.push(
      `Retained ${formatResultCount(counts.active, 'active execution')}.`,
    );
  }
  if (counts.failed > 0) {
    sentences.push(
      `Failed to delete ${formatResultCount(counts.failed, 'execution')}.`,
    );
  }
  return sentences.join(' ');
}

export function formatActiveStreamRetention(count: number): string {
  return count === 1
    ? 'The stream is still active in TeXRA and was not deleted.'
    : `${formatResultCount(count, 'stream')} are still active in TeXRA and were not deleted.`;
}

export function formatStreamDeletionRetention(
  activeCount: number,
  failedCount: number,
): string {
  const reasons = joinCountedParts([
    activeCount > 0
      ? formatResultCount(activeCount, 'active stream')
      : undefined,
    failedCount > 0
      ? formatResultCount(
          failedCount,
          'stream that could not be deleted',
          'streams that could not be deleted',
        )
      : undefined,
  ]);
  return `Kept ${reasons}.`;
}
