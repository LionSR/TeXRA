import { Predicate } from 'effect';

import {
  collapseWhitespace,
  formatResultCount,
} from '@texra-ai/worldline/schemas';
import type { CliHistoryEntry } from './history';

/**
 * What a history entry is about: its first input file, or, for runs started
 * without one, the session description collapsed to a single line. Both
 * callers render this inside one line of output, so the collapse is not
 * optional.
 */
export function formatCliHistorySubject(
  entry: Pick<CliHistoryEntry, 'description' | 'inputBasename'>,
  noInputLabel: string,
): string {
  if (entry.inputBasename !== '-') return entry.inputBasename;
  return (
    (entry.description && collapseWhitespace(entry.description)) || noInputLabel
  );
}

/** What `texra history delete --all` did: the tasks it deleted, then the
 *  active ones it kept and the ones it could not delete, when there are any. */
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
