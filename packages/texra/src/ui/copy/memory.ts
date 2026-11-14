/**
 * How a stored memory's facts read in every host: the settings view's meta
 * strip and the CLI's memory list both show these parts, joined their own way.
 */
import {
  formatResultCount,
  type MemoryViewItem,
} from '@texra-ai/harness/schemas';
import { formatBytes } from '@ui/copy/format';
import { formatShortDateTime } from '@ui/formatting/dateTimeFormat';

/** A memory's facts in reading order: pinned, size, lines, last update and
 *  who made it. */
export function memoryItemFacts(item: MemoryViewItem): readonly string[] {
  const updated = formatShortDateTime(item.mtime);
  return [
    ...(item.pinned ? ['Pinned'] : []),
    formatBytes(item.size),
    ...(item.lineCount === undefined
      ? []
      : [formatResultCount(item.lineCount, 'line')]),
    updated ? `Updated ${updated}` : 'Updated: unknown',
    ...(item.modifiedBy ? [`by ${item.modifiedBy}`] : []),
  ];
}
