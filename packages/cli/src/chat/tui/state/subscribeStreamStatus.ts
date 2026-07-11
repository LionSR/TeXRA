// Mirror the default session's status machine `onDidChange` into the
// per-stream status signal.

import { projectStreamTranscriptForStatus } from './transcriptProjection';
import { applyStreamStatusChange, onStreamStatusChange } from './streamStatus';

export function subscribeStreamStatus(): () => void {
  return onStreamStatusChange((change) => {
    // Patch status BEFORE projection so the transcript projector derives
    // `finalizeDeferred` from the current status. A reused stream still
    // carrying `WAITING` from the previous turn would otherwise finalize
    // the next run's first chunks early, shoving partial text into
    // `<Static>` before it finished streaming.
    applyStreamStatusChange(change);
    projectStreamTranscriptForStatus(change.streamId, change.status);
  });
}
