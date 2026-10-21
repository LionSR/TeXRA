import { formatResultCount } from '@texra-ai/harness/transcript';
import { Predicate } from 'effect';

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
    .filter(Predicate.isNotNullish)
    .join(' ');
}
