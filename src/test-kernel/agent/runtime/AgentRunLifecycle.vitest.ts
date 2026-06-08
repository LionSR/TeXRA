// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  END_GROUP_STATUS,
  STREAM_STATUS,
  type ExecutionId,
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

  return {
    config: {
      agent: 'test-agent',
      model: 'test-model',
    },
    setting: {
      agentCategory: AgentCategory.ToolUse,
    },
    streamId,
    executionId,
    runtimeHost: explicit.host,
    streamStatus,
    logger: {
      debug: vi.fn(),
    },
    parentStage: {
      end: vi.fn(),
    },
    modelHandler: {
      dispose: vi.fn(),
    },
    disposeTrace: vi.fn(),
    coordinators: {},
  } as unknown as AgentLaunchContext;
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
});
