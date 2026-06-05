// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@shared/schemas';

import { patchStream, updateChildStreamStatus } from './cliState';
import { projectStreamTranscriptForStatus } from './transcriptProjection';

export function subscribeStreamStatus(): () => void {
  return StreamStatusService.onDidChange((change) => {
    // Patch status BEFORE projection so the transcript projector derives
    // `finalizeDeferred` from the current status. A reused stream still
    // carrying `WAITING` from the previous turn would otherwise finalize
    // the next run's first chunks early, shoving partial text into
    // `<Static>` before it finished streaming.
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
    projectStreamTranscriptForStatus(change.streamId, change.status);
  });
}
