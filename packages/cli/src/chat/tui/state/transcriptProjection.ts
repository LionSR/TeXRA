import type { StreamPhase, StreamTabId } from '@shared/schemas';

import { isChildStreamRemoved } from './childExecutions';
import { syncStreamLog } from './subscribeStreamLog';
import {
  finalizeAssistantTranscriptEntries,
  isFinalTranscriptStatus,
} from './transcript';

export interface ProjectStreamTranscriptOptions {
  /** Promote all deferred assistant/tool rows into static scrollback. */
  readonly finalize?: boolean;
}

/**
 * Single projection edge from StreamLogStore into the CLI state slices.
 *
 * Callers that know a stream reached a turn boundary should project through
 * this helper instead of open-coding sync + finalization. That keeps
 * transcript ordering owned by one path.
 */
export function projectStreamTranscript(
  streamId: StreamTabId,
  options: ProjectStreamTranscriptOptions = {},
): void {
  if (isChildStreamRemoved(streamId)) return;
  syncStreamLog(streamId);
  if (options.finalize) {
    finalizeAssistantTranscriptEntries(streamId);
  }
}

/** Project a stream after a status transition. Final statuses promote rows. */
export function projectStreamTranscriptForStatus(
  streamId: StreamTabId,
  status: StreamPhase,
): void {
  projectStreamTranscript(streamId, {
    finalize: isFinalTranscriptStatus(status),
  });
}
