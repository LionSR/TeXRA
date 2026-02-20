// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

export const StreamSortSchema = z.enum(['time', 'agent', 'inputFile']);
export type StreamSort = z.infer<typeof StreamSortSchema>;
export interface StreamSortOptions {
  getLastActivityTimestamp?: (stream: StreamTabInfo) => number | undefined;
}

export type StreamComparator = (a: StreamTabInfo, b: StreamTabInfo) => number;

function compareByAgent(a: StreamTabInfo, b: StreamTabInfo): number {
  return (a.agent ?? '').localeCompare(b.agent ?? '');
}

function compareByInputFile(a: StreamTabInfo, b: StreamTabInfo): number {
  return (a.inputFile ?? '').localeCompare(b.inputFile ?? '');
}

function compareByTime(
  a: StreamTabInfo,
  b: StreamTabInfo,
  options?: StreamSortOptions,
): number {
  // Treat streams without timestamps as newest (sort to top)
  const now = Date.now();
  const aTime =
    options?.getLastActivityTimestamp?.(a) ?? a.creationTimestamp ?? now;
  const bTime =
    options?.getLastActivityTimestamp?.(b) ?? b.creationTimestamp ?? now;
  return bTime - aTime;
}

export const streamComparators: Record<
  StreamSort,
  (a: StreamTabInfo, b: StreamTabInfo, options?: StreamSortOptions) => number
> = {
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
  options?: StreamSortOptions,
): StreamTabInfo[] {
  const comparator =
    streamComparators[sort] ?? ((a, b) => compareByTime(a, b, options));
  return [...streams].sort((a, b) => comparator(a, b, options));
}
