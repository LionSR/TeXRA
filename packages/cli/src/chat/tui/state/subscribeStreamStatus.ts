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
    syncStreamLog(change.streamId);
    if (isFinalTranscriptStatus(change.status)) {
      finalizeAssistantTranscriptEntries(change.streamId);
    }
    patchStream(change.streamId, (slice) => ({
      ...slice,
      status: change.status,
    }));
  });
}
