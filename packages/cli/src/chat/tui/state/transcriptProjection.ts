import type { StreamLifecycleStatus, StreamTabId } from '@shared/schemas';

import { syncStreamLog } from './subscribeStreamLog';
import {
  appendAssistantTranscriptIfMissing,
  finalizeAssistantTranscriptEntries,
  isFinalTranscriptStatus,
} from './transcript';

interface TranscriptFallbackAssistant {
  readonly text: string | undefined;
  readonly idPrefix: string;
}

export interface ProjectStreamTranscriptOptions {
  /**
   * Fallback text from the agent result when the stream log did not already
   * materialize the final assistant block.
   */
  readonly fallbackAssistant?: TranscriptFallbackAssistant;
  /** Promote all deferred assistant/tool rows into static scrollback. */
  readonly finalize?: boolean;
}

/**
 * Single projection edge from StreamLogStore into the CLI state slices.
 *
 * Callers that know a stream reached a turn boundary should project through
 * this helper instead of open-coding sync + fallback + finalization. That keeps
 * transcript ordering and dedupe rules owned by one path.
 */
export function projectStreamTranscript(
  streamId: StreamTabId,
  options: ProjectStreamTranscriptOptions = {},
): void {
  syncStreamLog(streamId);
  if (options.fallbackAssistant) {
    appendAssistantTranscriptIfMissing(
      streamId,
      options.fallbackAssistant.text,
      options.fallbackAssistant.idPrefix,
    );
  }
  if (options.finalize) {
    finalizeAssistantTranscriptEntries(streamId);
  }
}

/** Project a stream after a status transition. Final statuses promote rows. */
export function projectStreamTranscriptForStatus(
  streamId: StreamTabId,
  status: StreamLifecycleStatus,
): void {
  projectStreamTranscript(streamId, {
    finalize: isFinalTranscriptStatus(status),
  });
}
