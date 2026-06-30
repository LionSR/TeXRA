import { describe, expect, it, vi } from 'vitest';

import type { ManualCompactionRequestResult } from '@agent/runtime/executionRegistry';
import { requestCliCompaction } from '@cli/chat/tui/state/compactionRequest';

describe('requestCliCompaction', () => {
  it('reports a missing active stream without touching follow-up state', () => {
    const appendTranscript = vi.fn();
    const requestManualCompaction = vi.fn(
      (): ManualCompactionRequestResult => ({ kind: 'no_active_tool_use' }),
    );
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: undefined,
      requestManualCompaction,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(requestManualCompaction).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'No active tool-use session found for context compaction.',
      undefined,
    );
  });

  it('reports a stale active stream when no flow context is registered', () => {
    const appendTranscript = vi.fn();
    const requestManualCompaction = vi.fn(
      (): ManualCompactionRequestResult => ({
        kind: 'no_active_tool_use',
        streamId: 'stream-1',
      }),
    );
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      requestManualCompaction,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(requestManualCompaction).toHaveBeenCalledExactlyOnceWith('stream-1');
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'No active tool-use session found for context compaction.',
      'stream-1',
    );
  });

  it('reports models that cannot compact manually', () => {
    const appendTranscript = vi.fn();
    const requestManualCompaction = vi.fn(
      (): ManualCompactionRequestResult => ({
        kind: 'unsupported',
        streamId: 'stream-1',
      }),
    );
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      requestManualCompaction,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(requestManualCompaction).toHaveBeenCalledExactlyOnceWith('stream-1');
    expect(notifyFollowUpSent).not.toHaveBeenCalled();
    expect(appendTranscript).toHaveBeenCalledWith(
      'Manual context compaction is not available for the current model.',
      'stream-1',
    );
  });

  it('requests compaction and wakes the active tool-use flow', () => {
    const appendTranscript = vi.fn();
    const requestManualCompaction = vi.fn(
      (): ManualCompactionRequestResult => ({
        kind: 'requested',
        streamId: 'stream-1',
      }),
    );
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId: 'stream-1',
      requestManualCompaction,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(requestManualCompaction).toHaveBeenCalledExactlyOnceWith('stream-1');
    expect(notifyFollowUpSent).toHaveBeenCalledExactlyOnceWith(
      'stream-1',
      undefined,
    );
    expect(appendTranscript).toHaveBeenCalledWith(
      'Context compaction requested. The agent will process it on the next model call.',
      'stream-1',
    );
  });
});
