// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  clearAllStreamStatusesForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  SharedExecutionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { onFollowUpSent, sendFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { STREAM_PHASE, STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

describe('tool-use follow-up progress events', () => {
  let unsubscribeFollowUpObserver: (() => void) | undefined;
  const trackedExecutionIds = new Set<string>();

  afterEach(() => {
    unsubscribeFollowUpObserver?.();
    unsubscribeFollowUpObserver = undefined;
    for (const executionId of trackedExecutionIds) {
      SharedExecutionRegistry.untrack(executionId);
    }
    trackedExecutionIds.clear();
    clearAllStreamStatusesForTest(StreamStatusService);
  });

  function trackToolUseFlow({
    stream = streamId,
    host = noopAgentRuntimeHost,
    appendFollowUp,
    executionId = `exec-${stream}`,
  }: {
    readonly stream?: StreamTabId;
    readonly host?: AgentRuntimeHost;
    readonly appendFollowUp: LiveToolUseFlowContext['session']['appendFollowUp'];
    readonly executionId?: string;
  }): void {
    const handle = new AgentExecutionHandle(
      executionId,
      stream,
      stream,
      'search',
      'toolUse',
      host,
    );
    handle.attachToolUseFlow({
      session: { appendFollowUp },
      modelHandler: { supportsManualCompaction: true },
      runtimeHost: host,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
    });
    SharedExecutionRegistry.track(handle);
    trackedExecutionIds.add(executionId);
  }

  it('publishes sent follow-up events through the active runtime host', async () => {
    const { events, host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    trackToolUseFlow({ host, appendFollowUp });

    const result = await sendFollowUp(streamId, 'please continue');

    expect(result).toEqual({ status: 'sent' });
    expect(appendFollowUp).toHaveBeenCalledWith({
      text: 'please continue',
      mediaFiles: undefined,
      displayText: undefined,
    });
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

    trackToolUseFlow({ host, appendFollowUp: vi.fn() });

    await sendFollowUp(streamId, 'break wait');
    unsubscribeFollowUpObserver();
    unsubscribeFollowUpObserver = undefined;
    await sendFollowUp(streamId, 'after unsubscribe');

    expect(observed).toEqual([streamId]);
  });

  it('does not append through stale active contexts after final status', async () => {
    const { host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    seedStreamStatusForTest(
      StreamStatusService,
      streamId,
      STREAM_PHASE.COMPLETED,
    );
    trackToolUseFlow({ host, appendFollowUp });

    const result = await sendFollowUp(streamId, 'late follow-up');

    expect(result).toEqual({
      status: 'no_session',
      streamStatus: STREAM_PHASE.COMPLETED,
    });
    expect(appendFollowUp).not.toHaveBeenCalled();
  });

  it('queues follow-ups for resuming streams through registry admission', async () => {
    const resumingStreamId = 'stream:resuming-follow-up' as StreamTabId;

    seedStreamStatusForTest(
      StreamStatusService,
      resumingStreamId,
      STREAM_STATUS.RESUMING,
    );

    try {
      const result = await sendFollowUp(
        resumingStreamId,
        'queued while resuming',
      );

      expect(result).toEqual({
        status: 'queued',
        reason: 'resuming',
      });
      expect(ToolUseFollowUpQueue.getAll(resumingStreamId)).toEqual([
        'queued while resuming',
      ]);
    } finally {
      ToolUseFollowUpQueue.release(resumingStreamId);
    }
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

    seedStreamStatusForTest(
      StreamStatusService,
      parentStreamId,
      STREAM_STATUS.STOPPED,
    );
    SharedExecutionRegistry.track(handle);

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
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });
});
