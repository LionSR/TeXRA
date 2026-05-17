// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';

import { patchStream } from './cliState';
import { syncStreamLog } from './subscribeStreamLog';
import { finalizeAssistantTranscriptEntries } from './transcript';

const FINAL_TRANSCRIPT_STATUSES: ReadonlySet<StreamStatus> = new Set([
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.WAITING,
]);

export function subscribeStreamStatus(): () => void {
  return StreamStatusService.onDidChange((change) => {
    syncStreamLog(change.streamId);
    if (FINAL_TRANSCRIPT_STATUSES.has(change.status)) {
      finalizeAssistantTranscriptEntries(change.streamId);
    }
    patchStream(change.streamId, (slice) => ({
      ...slice,
      status: change.status,
    }));
  });
}
