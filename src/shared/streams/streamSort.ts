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
  const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
  const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
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
  return [...streams].sort(streamComparators[sort] ?? streamComparators.time);
}
