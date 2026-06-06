import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

interface CliCompactionFlowContext {
  readonly modelHandler: {
    readonly supportsManualCompaction: boolean;
  };
  readonly runtimeHost?: AgentRuntimeHost;
  requestImmediateCompaction(): void;
}

export interface CliCompactionRequestOptions {
  readonly streamId: StreamTabId | undefined;
  readonly getFlowContext: (
    streamId: StreamTabId,
  ) => CliCompactionFlowContext | undefined;
  readonly notifyFollowUpSent: (
    streamId: StreamTabId,
    runtimeHost?: AgentRuntimeHost,
  ) => void;
  readonly appendTranscript: (message: string, streamId?: StreamTabId) => void;
}

export function requestCliCompaction({
  streamId,
  getFlowContext,
  notifyFollowUpSent,
  appendTranscript,
}: CliCompactionRequestOptions): void {
  const flowContext = streamId ? getFlowContext(streamId) : undefined;
  if (!streamId || !flowContext) {
    appendTranscript(
      'No active tool-use session found for context compaction.',
      streamId,
    );
    return;
  }

  if (!flowContext.modelHandler.supportsManualCompaction) {
    appendTranscript(
      'Manual context compaction is not available for the current model.',
      streamId,
    );
    return;
  }

  flowContext.requestImmediateCompaction();
  notifyFollowUpSent(streamId, flowContext.runtimeHost);
  appendTranscript(
    'Context compaction requested. The agent will process it on the next model call.',
    streamId,
  );
}
