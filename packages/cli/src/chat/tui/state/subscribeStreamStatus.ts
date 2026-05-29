// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@shared/schemas';

import { patchStream } from './cliState';
import { syncStreamLog } from './subscribeStreamLog';
import {
  finalizeAssistantTranscriptEntries,
  isFinalTranscriptStatus,
} from './transcript';

export function subscribeStreamStatus(): () => void {
  return StreamStatusService.onDidChange((change) => {
    // Patch status BEFORE syncing so `syncStreamLog` derives
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
    syncStreamLog(change.streamId);
    if (isFinalTranscriptStatus(change.status)) {
      finalizeAssistantTranscriptEntries(change.streamId);
    }
  });
}
