// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';

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
    patchStream(change.streamId, (slice) =>
      slice.status === change.status
        ? slice
        : { ...slice, status: change.status },
    );
    syncStreamLog(change.streamId);
    if (isFinalTranscriptStatus(change.status)) {
      finalizeAssistantTranscriptEntries(change.streamId);
    }
  });
}
