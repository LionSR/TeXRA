import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasPersistedFlowRecord: vi.fn(),
}));

vi.mock('@agent/storage/detectWaitingStreams', () => ({
  hasPersistedFlowRecord: mocks.hasPersistedFlowRecord,
}));

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  detectPersistedToolUseWaitingSession,
  finishToolUseResume,
  prepareToolUseResume,
  restoreToolUseResumeFollowUps,
} from '@agent/runtime/toolUseResume';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

const DETECT_STREAM = 'tool-use-resume-detect' as StreamTabId;
const RESUME_STREAM = 'tool-use-resume-prepare' as StreamTabId;

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime tool-use resume commands', () => {
  beforeEach(() => {
    mocks.hasPersistedFlowRecord.mockReset();
    StreamStatusService.clear(DETECT_STREAM, { emit: false });
    StreamStatusService.clear(RESUME_STREAM, { emit: false });
    ToolUseFollowUpQueue.release(DETECT_STREAM);
    ToolUseFollowUpQueue.release(RESUME_STREAM);
  });

  afterEach(() => {
    StreamStatusService.clear(DETECT_STREAM, { emit: false });
    StreamStatusService.clear(RESUME_STREAM, { emit: false });
    ToolUseFollowUpQueue.release(DETECT_STREAM);
    ToolUseFollowUpQueue.release(RESUME_STREAM);
  });

  it('marks a stream waiting when persisted tool-use flow data exists', async () => {
    const host = createRecordingHost();
    StreamStatusService.set(DETECT_STREAM, STREAM_STATUS.STOPPED, {
      emit: false,
    });
    mocks.hasPersistedFlowRecord.mockResolvedValue(true);

    await expect(
      detectPersistedToolUseWaitingSession({
        streamId: DETECT_STREAM,
        executionId: 'exec-tool-use-resume-detect',
        runtimeHost: host,
      }),
    ).resolves.toBe(true);

    expect(mocks.hasPersistedFlowRecord).toHaveBeenCalledWith(
      'exec-tool-use-resume-detect',
    );
    expect(StreamStatusService.get(DETECT_STREAM)).toBe(STREAM_STATUS.WAITING);
    expect(host.emit).toHaveBeenCalledWith(
      'updateStreamStatus',
      expect.objectContaining({
        streamId: DETECT_STREAM,
        status: STREAM_STATUS.WAITING,
      }),
    );
  });

  it('drains, restores, and finalizes queued resume follow-ups', () => {
    const host = createRecordingHost();
    const queue = ToolUseFollowUpQueue.acquire(RESUME_STREAM);
    queue.enqueue({ text: 'queued follow-up' });

    const preparation = prepareToolUseResume({
      streamId: RESUME_STREAM,
      runtimeHost: host,
      followUp: 'explicit follow-up',
    });

    expect(preparation).not.toBeNull();
    if (!preparation) {
      throw new Error('Expected resume preparation.');
    }
    expect(preparation).toEqual({
      streamId: RESUME_STREAM,
      followUps: [
        { text: 'explicit follow-up', origin: 'user' },
        { text: 'queued follow-up', origin: 'user' },
      ],
    });
    expect(StreamStatusService.get(RESUME_STREAM)).toBe(STREAM_STATUS.RESUMING);
    expect(ToolUseFollowUpQueue.getAll(RESUME_STREAM)).toEqual([]);

    restoreToolUseResumeFollowUps({
      ...preparation,
      runtimeHost: host,
    });

    expect(ToolUseFollowUpQueue.getAll(RESUME_STREAM)).toEqual([
      'explicit follow-up',
      'queued follow-up',
    ]);

    finishToolUseResume({
      streamId: RESUME_STREAM,
      runtimeHost: host,
    });

    expect(StreamStatusService.get(RESUME_STREAM)).toBe(STREAM_STATUS.WAITING);
  });
});
