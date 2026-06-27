import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resumeToolUseFromSnapshot: vi.fn(),
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromSnapshot: mocks.resumeToolUseFromSnapshot,
}));

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  requestRuntimeToolUseSnapshotResume,
  type RuntimeToolUseSessionSnapshot,
} from '@agent/runtime/resumeCommands';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

const STREAM_ID = 'runtime-resume-command-stream' as StreamTabId;

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

function createSnapshot(): RuntimeToolUseSessionSnapshot {
  return {
    version: 2,
    executionId: 'runtime-resume-command-execution',
    streamId: STREAM_ID,
    agentConfig: AgentConfigSchema.parse({
      model: 'demo-model',
      agent: 'demo-agent',
      agentCategory: 'toolUse',
    }),
    messages: [],
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: AgentWorkspaceState.create().toSnapshot(),
    user: {
      input: {},
      transient: {},
    },
    lastUpdated: Date.now(),
  };
}

describe('runtime resume commands', () => {
  beforeEach(() => {
    mocks.resumeToolUseFromSnapshot.mockReset();
    StreamStatusService.clear(STREAM_ID, { emit: false });
    ToolUseFollowUpQueue.release(STREAM_ID);
  });

  afterEach(() => {
    StreamStatusService.clear(STREAM_ID, { emit: false });
    ToolUseFollowUpQueue.release(STREAM_ID);
  });

  it('prepares queued follow-ups and resumes a tool-use snapshot', async () => {
    const host = createRecordingHost();
    ToolUseFollowUpQueue.acquire(STREAM_ID).enqueue({
      text: 'queued follow-up',
    });
    const appended: unknown[] = [];
    mocks.resumeToolUseFromSnapshot.mockImplementation(
      async (_snapshot, _runtimeHost, options) => {
        options.setupSession({
          appendFollowUp: (item: unknown) => appended.push(item),
        });
      },
    );

    await expect(
      requestRuntimeToolUseSnapshotResume({
        snapshot: createSnapshot(),
        runtimeHost: host,
        followUp: 'explicit follow-up',
        approvalPromptsUnavailable: true,
      }),
    ).resolves.toBe(true);

    expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: STREAM_ID }),
      host,
      expect.objectContaining({
        approvalPromptsUnavailable: true,
      }),
    );
    expect(appended).toEqual([
      { text: 'explicit follow-up', origin: 'user' },
      { text: 'queued follow-up', origin: 'user' },
    ]);
    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.WAITING);
    expect(ToolUseFollowUpQueue.getAll(STREAM_ID)).toEqual([]);
  });

  it('restores drained follow-ups and rethrows when snapshot resume fails', async () => {
    const host = createRecordingHost();
    ToolUseFollowUpQueue.acquire(STREAM_ID).enqueue({
      text: 'queued follow-up',
    });
    mocks.resumeToolUseFromSnapshot.mockRejectedValue(
      new Error('resume failed'),
    );

    await expect(
      requestRuntimeToolUseSnapshotResume({
        snapshot: createSnapshot(),
        runtimeHost: host,
        followUp: 'explicit follow-up',
      }),
    ).rejects.toThrow('resume failed');

    expect(ToolUseFollowUpQueue.getAll(STREAM_ID)).toEqual([
      'explicit follow-up',
      'queued follow-up',
    ]);
    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.WAITING);
  });

  it('does not finish a resume state owned by another runtime consumer', async () => {
    const host = createRecordingHost();
    StreamStatusService.set(STREAM_ID, STREAM_STATUS.RESUMING, {
      runtimeHost: host,
    });

    await expect(
      requestRuntimeToolUseSnapshotResume({
        snapshot: createSnapshot(),
        runtimeHost: host,
      }),
    ).resolves.toBe(false);

    expect(mocks.resumeToolUseFromSnapshot).not.toHaveBeenCalled();
    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.RESUMING);
  });
});
