import { describe, expect, it, vi } from 'vitest';

import type { ManualCompactionRequestResult } from '@agent/runtime/executionRegistry';
import { requestCliCompaction } from '@cli/chat/tui/state/compactionRequest';

const NO_ACTIVE_MESSAGE =
  'No active tool-use session found for context compaction.';

const CASES: readonly {
  readonly name: string;
  readonly streamId: string | undefined;
  readonly result: ManualCompactionRequestResult;
  readonly wakesFlow: boolean;
  readonly message: string;
}[] = [
  {
    name: 'reports a missing active stream without touching follow-up state',
    streamId: undefined,
    result: { kind: 'no_active_tool_use' },
    wakesFlow: false,
    message: NO_ACTIVE_MESSAGE,
  },
  {
    name: 'reports a stale active stream when no flow context is registered',
    streamId: 'stream-1',
    result: { kind: 'no_active_tool_use', streamId: 'stream-1' },
    wakesFlow: false,
    message: NO_ACTIVE_MESSAGE,
  },
  {
    name: 'reports models that cannot compact manually',
    streamId: 'stream-1',
    result: { kind: 'unsupported', streamId: 'stream-1' },
    wakesFlow: false,
    message: 'Manual context compaction is not available for this model.',
  },
  {
    name: 'requests compaction and wakes the active tool-use flow',
    streamId: 'stream-1',
    result: { kind: 'requested', streamId: 'stream-1' },
    wakesFlow: true,
    message:
      'Context compaction requested. The agent will process it on the next model call.',
  },
];

describe('requestCliCompaction', () => {
  it.each(CASES)('$name', ({ streamId, result, wakesFlow, message }) => {
    const appendTranscript = vi.fn();
    const requestManualCompaction = vi.fn(
      (): ManualCompactionRequestResult => result,
    );
    const notifyFollowUpSent = vi.fn();

    requestCliCompaction({
      streamId,
      requestManualCompaction,
      notifyFollowUpSent,
      appendTranscript,
    });

    expect(requestManualCompaction).toHaveBeenCalledExactlyOnceWith(streamId);
    if (wakesFlow) {
      expect(notifyFollowUpSent).toHaveBeenCalledExactlyOnceWith(
        result.streamId,
        undefined,
      );
    } else {
      expect(notifyFollowUpSent).not.toHaveBeenCalled();
    }
    expect(appendTranscript).toHaveBeenCalledWith(message, result.streamId);
  });
});
