// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

export const StreamSortSchema = z.enum(['time', 'agent', 'inputFile']);
export type StreamSort = z.infer<typeof StreamSortSchema>;

export type StreamComparator = (a: StreamTabInfo, b: StreamTabInfo) => number;

function compareByAgent(a: StreamTabInfo, b: StreamTabInfo): number {
  return (a.agent ?? '').localeCompare(b.agent ?? '');
}

function compareByInputFile(a: StreamTabInfo, b: StreamTabInfo): number {
  return (a.inputFile ?? '').localeCompare(b.inputFile ?? '');
}

function compareByTime(a: StreamTabInfo, b: StreamTabInfo): number {
  // Treat streams without timestamps as newest (sort to top)
  const now = Date.now();
  const aTime = a.lastTimestamp ?? a.creationTimestamp ?? now;
  const bTime = b.lastTimestamp ?? b.creationTimestamp ?? now;
  return bTime - aTime;
}

export const streamComparators: Record<StreamSort, StreamComparator> = {
  agent: compareByAgent,
  inputFile: compareByInputFile,
  time: compareByTime,
};

/**
 * Sort streams by the specified criteria.
 * Returns sorted copy without mutating original.
 */
export function sortStreams(
  streams: StreamTabInfo[],
  sort: StreamSort,
): StreamTabInfo[] {
  const comparator = streamComparators[sort] ?? streamComparators.time;
  return [...streams].sort(comparator);
}
