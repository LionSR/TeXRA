// Mirror `StreamStatusService.onDidChange` into the per-stream status signal.

import { StreamStatusService } from '@agent/runtime/StreamStatusService';

import { patchStream } from './cliState';

export function subscribeStreamStatus(): () => void {
  return StreamStatusService.onDidChange((change) => {
    patchStream(change.streamId, (slice) => ({
      ...slice,
      status: change.status,
    }));
  });
}
