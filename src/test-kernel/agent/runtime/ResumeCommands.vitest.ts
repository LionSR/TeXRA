import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resumeToolUseFromSnapshot: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromSnapshot: mocks.resumeToolUseFromSnapshot,
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { TaskState } from '@agent/core/execution/TaskState';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import {
  readRuntimeToolUseResumeDataForConfig,
  readRuntimeSessionResumeData,
  requestRuntimeToolUseSnapshotResume,
  requestRuntimeWorkflowResume,
  type RuntimeToolUseSessionSnapshot,
} from '@agent/runtime/resumeCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

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
    mocks.retrieveSessionResumeData.mockReset();
    StreamStatusService.clear(STREAM_ID, { emit: false });
    ToolUseFollowUpQueue.release(STREAM_ID);
  });

  afterEach(() => {
    StreamStatusService.clear(STREAM_ID, { emit: false });
    ToolUseFollowUpQueue.release(STREAM_ID);
  });

  it('prepares queued follow-ups and resumes a tool-use snapshot', async () => {
    const host = createRecordingHost();
    const session = new SessionHandle();
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

    try {
      await expect(
        requestRuntimeToolUseSnapshotResume({
          snapshot: createSnapshot(),
          runtimeHost: host,
          followUp: 'explicit follow-up',
          approvalPromptsUnavailable: true,
          session,
        }),
      ).resolves.toBe(true);

      expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: STREAM_ID }),
        host,
        expect.objectContaining({
          approvalPromptsUnavailable: true,
          session,
        }),
      );
      expect(appended).toEqual([
        { text: 'explicit follow-up', origin: 'user' },
        { text: 'queued follow-up', origin: 'user' },
      ]);
      expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.WAITING);
      expect(ToolUseFollowUpQueue.getAll(STREAM_ID)).toEqual([]);
    } finally {
      session.dispose();
    }
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

  it('owns workflow resume status transitions around the launch callback', async () => {
    const host = createRecordingHost();
    const launch = vi.fn(async () => {
      expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.RESUMING);
      StreamStatusService.set(STREAM_ID, STREAM_STATUS.RUNNING, {
        runtimeHost: host,
      });
    });

    await expect(
      requestRuntimeWorkflowResume({
        streamId: STREAM_ID,
        runtimeHost: host,
        run: launch,
      }),
    ).resolves.toBe(true);

    expect(launch).toHaveBeenCalledOnce();
    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.RUNNING);
  });

  it('restores WAITING when workflow resume launch fails before claiming the stream', async () => {
    const host = createRecordingHost();

    await expect(
      requestRuntimeWorkflowResume({
        streamId: STREAM_ID,
        runtimeHost: host,
        run: async () => {
          throw new Error('workflow resume failed');
        },
      }),
    ).rejects.toThrow('workflow resume failed');

    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.WAITING);
  });

  it('does not overwrite workflow resume status when the launch callback already changed it', async () => {
    const host = createRecordingHost();

    await expect(
      requestRuntimeWorkflowResume({
        streamId: STREAM_ID,
        runtimeHost: host,
        run: async () => {
          StreamStatusService.set(STREAM_ID, STREAM_STATUS.ERROR, {
            runtimeHost: host,
          });
          throw new Error('workflow lifecycle failed');
        },
      }),
    ).rejects.toThrow('workflow lifecycle failed');

    expect(StreamStatusService.get(STREAM_ID)).toBe(STREAM_STATUS.ERROR);
  });

  it('classifies resume retrieval as resumable, missing, or failed', async () => {
    const executionId = 'runtime-resume-command-execution' as ExecutionId;
    const taskState = {
      agentConfig: createSnapshot().agentConfig,
    } as TaskState;
    const workflowResume = {
      type: 'workflow',
      agentConfig: createSnapshot().agentConfig,
      executionId,
    };

    mocks.retrieveSessionResumeData.mockResolvedValueOnce(workflowResume);
    await expect(
      readRuntimeSessionResumeData({
        streamId: STREAM_ID,
        executionId,
        taskState,
      }),
    ).resolves.toEqual({
      status: 'resumable',
      data: workflowResume,
    });

    mocks.retrieveSessionResumeData.mockResolvedValueOnce(null);
    await expect(
      readRuntimeSessionResumeData({
        streamId: STREAM_ID,
        executionId,
        taskState,
      }),
    ).resolves.toEqual({ status: 'missing' });

    mocks.retrieveSessionResumeData.mockRejectedValueOnce(
      new Error('KV timeout'),
    );
    await expect(
      readRuntimeSessionResumeData({
        streamId: STREAM_ID,
        executionId,
        taskState,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      message: 'KV timeout',
    });

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      STREAM_ID,
      executionId,
      taskState,
    );
  });

  it('resolves tool-use resume data from config and execution id', async () => {
    const executionId = 'runtime-resume-command-execution' as ExecutionId;
    const config = createSnapshot().agentConfig;
    const streamId = `demo-agent@demo-model#${executionId}` as StreamTabId;
    const snapshot = {
      ...createSnapshot(),
      executionId,
      streamId,
      agentConfig: AgentConfigSchema.parse({
        ...config,
        model: 'model-after-switch',
      }),
    };

    mocks.retrieveSessionResumeData.mockResolvedValueOnce({
      type: 'toolUse',
      snapshot,
    });

    await expect(
      readRuntimeToolUseResumeDataForConfig({ executionId, config }),
    ).resolves.toEqual({
      status: 'resumable',
      data: {
        snapshot,
        streamId,
        config: snapshot.agentConfig,
      },
    });
    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      streamId,
      executionId,
      expect.objectContaining({
        agentConfig: config,
        toolSessionState: {},
      }),
    );
  });

  it('does not read resume storage for workflow configs', async () => {
    const executionId = 'runtime-resume-command-execution' as ExecutionId;
    const config = AgentConfigSchema.parse({
      model: 'demo-model',
      agent: 'demo-agent',
      agentCategory: 'workflow',
      inputFiles: [],
      outputFiles: [],
    });

    await expect(
      readRuntimeToolUseResumeDataForConfig({ executionId, config }),
    ).resolves.toEqual({ status: 'not_tool_use' });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('classifies missing and failed config-based tool-use resume data', async () => {
    const executionId = 'runtime-resume-command-execution' as ExecutionId;
    const config = createSnapshot().agentConfig;
    const streamId = `demo-agent@demo-model#${executionId}` as StreamTabId;

    mocks.retrieveSessionResumeData.mockResolvedValueOnce(null);
    await expect(
      readRuntimeToolUseResumeDataForConfig({ executionId, config }),
    ).resolves.toEqual({ status: 'not_resumable', streamId });

    mocks.retrieveSessionResumeData.mockRejectedValueOnce(
      new Error('KV timeout'),
    );
    await expect(
      readRuntimeToolUseResumeDataForConfig({ executionId, config }),
    ).resolves.toMatchObject({
      status: 'failed',
      streamId,
      message: 'KV timeout',
    });
  });
});
