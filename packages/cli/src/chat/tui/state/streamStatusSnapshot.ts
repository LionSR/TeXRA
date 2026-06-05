import {
  StreamStatusService,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type StreamStatus,
  type StreamTabId,
} from '@shared/schemas';

import { cliState, patchStream, updateChildStreamStatus } from './cliState';

export function applyStreamStatusChange(change: StreamStatusChange): void {
  patchStream(change.streamId, (slice) => {
    if (slice.status === change.status) return slice;
    // Stamp the turn-start clock when entering RUNNING (keeping any prior
    // stamp if we re-enter without leaving), and clear it otherwise so the
    // StatusBar's elapsed segment only ticks during an active turn.
    const runStartedAt =
      change.status === STREAM_STATUS.RUNNING
        ? (slice.runStartedAt ?? Date.now())
        : undefined;
    return { ...slice, status: change.status, runStartedAt };
  });
  updateChildStreamStatus(change.streamId, change.status);
}

export function streamStatusForStream(
  streamId: StreamTabId,
): StreamStatus | undefined {
  return (
    cliState.streams.get().get(streamId)?.status ??
    StreamStatusService.get(streamId)
  );
}

export function streamStatusSnapshot(
  streamId: StreamTabId,
): readonly StreamStatus[] {
  const streams = cliState.streams.get();
  const parentStreamId = cliState.parentStream.get().get(streamId);
  const childStreamStatus = parentStreamId
    ? streams
        .get(parentStreamId)
        ?.childStreams.find((child) => child.childStreamId === streamId)?.status
    : undefined;
  return [
    childStreamStatus,
    streams.get(streamId)?.status,
    StreamStatusService.get(streamId),
  ].filter((status): status is StreamStatus => status != null);
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
