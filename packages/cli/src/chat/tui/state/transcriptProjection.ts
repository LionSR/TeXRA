import type { StreamTabId } from '@shared/schemas';

import { isChildStreamRemoved } from './childExecutions';
import { syncStreamLog } from './subscribeStreamLog';
import { finalizeAssistantTranscriptEntries } from './transcript';

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
