import {
  StreamStatusService,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type StreamStatus,
  type StreamTabId,
} from '@shared/schemas';

import { cliState, patchStream } from './cliState';

export function applyStreamStatusChange(change: StreamStatusChange): void {
  // StreamStatusService is the runtime source of truth. The slice status is a
  // UI mirror used by panes that render one stream directly; child ownership
  // rows project this value at read time instead of receiving copied updates.
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
}

export function effectiveStreamStatus(
  streamId: StreamTabId,
): StreamStatus | undefined {
  return (
    StreamStatusService.get(streamId) ??
    cliState.streams.get().get(streamId)?.status
  );
}

export function onStreamStatusChange(
  listener: (change: StreamStatusChange) => void,
): () => void {
  return StreamStatusService.onDidChange(listener);
}
