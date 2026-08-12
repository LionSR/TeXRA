import type {
  ManualCompactionRequestResult,
  SessionHandle,
} from '@agent/runtime';
import type { StreamTabId } from '@shared/schemas';

export interface CliCompactionRequestOptions {
  readonly streamId: StreamTabId | undefined;
  readonly requestManualCompaction: (
    streamId: StreamTabId | undefined,
  ) => ManualCompactionRequestResult;
  readonly notifyFollowUpSent: (
    streamId: StreamTabId,
    session?: SessionHandle,
  ) => void;
  readonly appendTranscript: (message: string, streamId?: StreamTabId) => void;
}

export function requestCliCompaction({
  streamId,
  requestManualCompaction,
  notifyFollowUpSent,
  appendTranscript,
}: CliCompactionRequestOptions): void {
  const result = requestManualCompaction(streamId);
  switch (result.kind) {
    case 'no_active_tool_use':
      appendTranscript(
        'No active tool-use session found for context compaction.',
        result.streamId,
      );
      return;
    case 'unsupported':
      appendTranscript(
        'Manual context compaction is not available for this model.',
        result.streamId,
      );
      return;
    case 'requested':
      notifyFollowUpSent(result.streamId, result.session);
      appendTranscript(
        'Context compaction requested. The agent will process it on the next model call.',
        result.streamId,
      );
      return;
  }
}
