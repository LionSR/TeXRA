import { filterNotNullish } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

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
  const reasons = [
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
  ].filter(filterNotNullish);
  return `Kept ${reasons.join(' and ')}.`;
}
