// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import { executionRegistry } from '@agent/runtime/executionRegistry';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  END_GROUP_STATUS,
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  writeTerminalStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: storageMocks.writeTerminalStatus,
}));

function createLifecycleContext({
  executionId,
  streamId,
  streamStatus,
}: {
  executionId: ExecutionId;
  streamId: StreamTabId;
  streamStatus: StreamStatusRegistry;
}): AgentLaunchContext {
  const explicit = createRecordingHost();
  const config = AgentConfigSchema.parse({
    agent: 'test-agent',
    model: 'test-model',
    agentCategory: AgentCategory.ToolUse,
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  const prompt = AgentPromptSchema.parse({});
  const storageKey = executionId as StorageKey;
  const modelInfo = {
    capabilities: {
      supportsPromptCaching: false,
      supportsAutoPromptCaching: false,
      supportsReasoning: false,
      cacheDiscountFactor: 0,
    },
    config: {
      provider: ModelProvider.OPENAI,
      name: 'test-model',
      fullName: 'Test Model',
      inputPrice: 0,
      openRouterOnly: false,
      requiresResponsesAPI: false,
    },
  };

  return {
    config,
    setting,
    prompt,
    streamId,
    executionId,
    runtimeHost: explicit.host,
    streamStatus,
    logger: noopTrace,
    parentStage: noopTrace.openStage('Run: test-agent'),
    storageKey,
    userVarChannels: {
      input: Object.freeze({}),
      transient: {},
    },
    usageMonitor: new UsageMonitor(
      modelInfo,
      {
        logger: noopTrace,
        runtimeHost: explicit.host,
        storageKey,
        streamId,
      },
      {
        agentName: config.agent,
        agentCategory: setting.agentCategory,
      },
    ),
    modelHandler: {
      dispose: vi.fn(),
    } as unknown as AgentLaunchContext['modelHandler'],
    disposeTrace: vi.fn(),
    coordinators: {
      plan: new PlanApprovalCoordinator(explicit.host),
      proposal: new AgentProposalCoordinator(explicit.host),
      retry: new RetryRequestCoordinatorImpl(explicit.host),
    },
  };
}

describe('runFlowWithLifecycle', () => {
  it('finalizes the stream status owner from the launch context', async () => {
    const executionId = 'execution-lifecycle-status-owner' as ExecutionId;
    const streamId = 'stream-lifecycle-status-owner' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        emit: false,
      });

      // This test scopes ownership to the lifecycle finalization path; other
      // mid-run status transitions are migrated in separate Step 7 slices.
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        status: END_GROUP_STATUS.STOPPED,
        executionId,
        streamId,
      }));

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      streamStatus.clear(streamId, { emit: false });
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('delivers subagent aborts through the terminal callback', async () => {
    const executionId = 'execution-lifecycle-subagent-abort' as ExecutionId;
    const streamId = 'stream-lifecycle-subagent-abort' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
    const onError = vi.fn();

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });

      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new DOMException('Request aborted', 'AbortError');
        },
        { isSubagent: true, onError },
      );

      expect(result.status).toBe(END_GROUP_STATUS.STOPPED);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      streamStatus.clear(streamId, { emit: false });
    }
  });

  it('keeps subagent errors registered until terminal delivery runs', async () => {
    const executionId =
      'execution-lifecycle-subagent-error-registered' as ExecutionId;
    const streamId =
      'stream-lifecycle-subagent-error-registered' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
    const onError = vi.fn(() => {
      expect(executionRegistry.getHandle(executionId)).toBeDefined();
    });

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });

      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new Error('subagent failed');
        },
        { isSubagent: true, onError },
      );

      expect(result.status).toBe(END_GROUP_STATUS.ERROR);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.ERROR);
      expect(onError).toHaveBeenCalledOnce();
      expect(executionRegistry.getHandle(executionId)).toBeUndefined();
    } finally {
      executionRegistry.untrack(executionId);
      streamStatus.clear(streamId, { emit: false });
    }
  });
});
