import { filterNotNullish } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

export function formatCliHistoryDeletionSummary(counts: {
  readonly deleted: number;
  readonly active: number;
  readonly failed: number;
}): string {
  return [
    `Deleted ${formatResultCount(counts.deleted, 'stored task')}.`,
    counts.active > 0
      ? `Retained ${formatResultCount(counts.active, 'active task')}.`
      : undefined,
    counts.failed > 0
      ? `Failed to delete ${formatResultCount(counts.failed, 'task')}.`
      : undefined,
  ]
    .filter(filterNotNullish)
    .join(' ');
}
