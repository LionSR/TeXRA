import { describe, expect, it, vi } from 'vitest';

import { requestCliCompaction } from '../../../packages/cli/src/chat/tui/state/compactionRequest';

function compactableFlow() {
  return {
    modelHandler: { supportsManualCompaction: true },
    runtimeHost: undefined,
    requestImmediateCompaction: vi.fn(),
  };
}

describe('requestCliCompaction', () => {
  it('reports a missing active stream without touching follow-up state', () => {
    const appendTranscript = vi.fn();
    const getFlowContext = vi.fn();
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: undefined,
      getFlowContext,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(getFlowContext).not.toHaveBeenCalled();
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'No active tool-use session found for context compaction.',
    );
  });

  it('reports a stale active stream when no flow context is registered', () => {
    const appendTranscript = vi.fn();
    const getFlowContext = vi.fn().mockReturnValue(undefined);
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      getFlowContext,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(getFlowContext).toHaveBeenCalledExactlyOnceWith('stream-1');
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'No active tool-use session found for context compaction.',
    );
  });

  it('reports models that cannot compact manually', () => {
    const appendTranscript = vi.fn();
    const flowContext = {
      modelHandler: { supportsManualCompaction: false },
      runtimeHost: undefined,
      requestImmediateCompaction: vi.fn(),
    };
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      getFlowContext: vi.fn().mockReturnValue(flowContext),
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(flowContext.requestImmediateCompaction).not.toHaveBeenCalled();
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'Manual context compaction is not available for the current model.',
    );
  });

  it('requests compaction and wakes the active tool-use flow', () => {
    const appendTranscript = vi.fn();
    const flowContext = compactableFlow();
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      getFlowContext: vi.fn().mockReturnValue(flowContext),
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(flowContext.requestImmediateCompaction).toHaveBeenCalledOnce();
    expect(notifyFollowUpSent).toHaveBeenCalledExactlyOnceWith(
      'stream-1',
      undefined,
    );
    expect(appendTranscript).toHaveBeenCalledWith(
      'Context compaction requested. The agent will process it on the next model call.',
    );
  });
});
