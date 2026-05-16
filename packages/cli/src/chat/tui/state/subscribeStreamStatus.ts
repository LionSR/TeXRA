// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';

import { patchStream } from './cliState';
import { syncStreamLog } from './subscribeStreamLog';

export function subscribeStreamStatus(): () => void {
  return StreamStatusService.onDidChange((change) => {
    syncStreamLog(change.streamId);
    patchStream(change.streamId, (slice) => ({
      ...slice,
      status: change.status,
    }));
  });
}
