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
