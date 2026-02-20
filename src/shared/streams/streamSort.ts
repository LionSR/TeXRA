// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import type { StreamState, StreamTabInfo } from '@shared/schemas';

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

/**
 * Build a time comparator that reads lastTimestamp from streamStates first,
 * falling back to StreamTabInfo fields. This lets status updates (which write
 * to StreamState.lastTimestamp) feed the sort without mutating streams[].
 */
function compareByTimeWithStates(
  streamStates: ReadonlyMap<string, StreamState>,
): StreamComparator {
  const now = Date.now();
  return (a, b) => {
    const aTime =
      streamStates.get(a.name)?.lastTimestamp ??
      a.lastTimestamp ??
      a.creationTimestamp ??
      now;
    const bTime =
      streamStates.get(b.name)?.lastTimestamp ??
      b.lastTimestamp ??
      b.creationTimestamp ??
      now;
    return bTime - aTime;
  };
}

export const streamComparators: Record<StreamSort, StreamComparator> = {
  agent: compareByAgent,
  inputFile: compareByInputFile,
  time: compareByTime,
};

/**
 * Sort streams by the specified criteria.
 * Returns sorted copy without mutating original.
 *
 * When `streamStates` is provided and sort is 'time', timestamps are read
 * from StreamState first (the live source of truth), falling back to
 * StreamTabInfo fields for streams that don't yet have state.
 */
export function sortStreams(
  streams: StreamTabInfo[],
  sort: StreamSort,
  streamStates?: ReadonlyMap<string, StreamState>,
): StreamTabInfo[] {
  const comparator =
    sort === 'time' && streamStates
      ? compareByTimeWithStates(streamStates)
      : (streamComparators[sort] ?? streamComparators.time);
  return [...streams].sort(comparator);
}
