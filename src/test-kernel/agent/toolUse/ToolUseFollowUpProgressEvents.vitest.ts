// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  trackExecution,
  untrackExecution,
} from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { onFollowUpSent, sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

describe('tool-use follow-up progress events', () => {
  let unsubscribeFollowUpObserver: (() => void) | undefined;

  afterEach(() => {
    unsubscribeFollowUpObserver?.();
    unsubscribeFollowUpObserver = undefined;
    unregisterInterruptible(streamId);
    StreamStatusService.clearAll({ emit: false });
  });

  it('publishes sent follow-up events through the active runtime host', async () => {
    const { events, host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    registerInterruptible(streamId, {
      session: { appendFollowUp },
      modelHandler: {},
      runtimeHost: host,
      interrupt: vi.fn(),
    } as unknown as ToolUseFlowContext);

    const result = await sendFollowUp(streamId, 'please continue');

    expect(result).toEqual({ status: 'sent' });
    expect(appendFollowUp).toHaveBeenCalledWith('please continue');
    expect(events).toEqual([
      {
        event: 'followUpSent',
        payload: { streamId },
      },
    ]);
  });

  it('notifies local follow-up observers without using the progress bus', async () => {
    const { host } = createRecordingHost();
    const observed: StreamTabId[] = [];
    unsubscribeFollowUpObserver = onFollowUpSent((observedStreamId) => {
      observed.push(observedStreamId);
    });

    registerInterruptible(streamId, {
      session: { appendFollowUp: vi.fn() },
      modelHandler: {},
      runtimeHost: host,
      interrupt: vi.fn(),
    } as unknown as ToolUseFlowContext);

    await sendFollowUp(streamId, 'break wait');
    unsubscribeFollowUpObserver();
    unsubscribeFollowUpObserver = undefined;
    await sendFollowUp(streamId, 'after unsubscribe');

    expect(observed).toEqual([streamId]);
  });

  it('does not append through stale active contexts after final status', async () => {
    const { host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, { emit: false });
    registerInterruptible(streamId, {
      session: { appendFollowUp },
      modelHandler: {},
      runtimeHost: host,
      interrupt: vi.fn(),
    } as unknown as ToolUseFlowContext);

    const result = await sendFollowUp(streamId, 'late follow-up');

    expect(result).toEqual({
      status: 'no_session',
      streamStatus: STREAM_STATUS.STOPPED,
    });
    expect(appendFollowUp).not.toHaveBeenCalled();
  });

  it('keeps terminal parents with active children on the children-running queue path', async () => {
    const parentStreamId = 'stream:terminal-parent' as StreamTabId;
    const childStreamId = 'stream:terminal-parent-child' as StreamTabId;
    const executionId = 'exec-terminal-parent-child';
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'critic',
      'toolUse',
      noopAgentRuntimeHost,
    );

    StreamStatusService.set(parentStreamId, STREAM_STATUS.STOPPED, {
      emit: false,
    });
    trackExecution(handle);

    try {
      const result = await sendFollowUp(parentStreamId, 'continue child');

      expect(result).toEqual({
        status: 'queued',
        reason: 'children_running',
      });
      expect(ToolUseFollowUpQueue.getAll(parentStreamId)).toEqual([
        'continue child',
      ]);
    } finally {
      untrackExecution(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });
});
