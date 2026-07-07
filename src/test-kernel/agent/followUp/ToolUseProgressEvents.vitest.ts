// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ToolUseCycleNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseCycleNode';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachLegacyProgressEventProjection } from '@agent/runtime/LegacyProgressEventProjection';
import type {
  CyclePrepResult,
  ToolUseRunShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  MESSAGE_TYPES,
  type Plan,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { createRecordingHost, withTestRunContext } from '../progressTestUtils';

const todo: TodoItem = {
  content: 'Wire progress events through runtime host',
  status: 'in_progress',
  activeForm: 'Wiring progress events',
};

const plan: Plan = {
  objective:
    'Move progress publication behind the runtime host.\n' +
    'Publish tool-use cycle state through runtimeHost.',
};

function createPrepResult(
  workspaceState: AgentWorkspaceState,
): CyclePrepResult {
  return {
    shouldSkipCycle: true,
    messages: [],
    runState: { totalRounds: 0 } as CyclePrepResult['runState'],
    workspaceState,
    userChannels: {} as CyclePrepResult['userChannels'],
  };
}

describe('tool-use progress events', () => {
  it('publishes skipped-cycle todo and plan events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const logger = new TraceEmitter();
    const hub = new SessionEventHub();
    const streamId = 'stream:tool-use-cycle' as StreamTabId;
    const detachTrace = logger.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const detachProjection = attachLegacyProgressEventProjection(hub, host);
    const workspaceState = AgentWorkspaceState.create();
    workspaceState.workPlan.updateTodos([todo]);
    workspaceState.workPlan.updatePlan(plan);

    const node = new ToolUseCycleNode().setServices({
      streamId,
      runtimeHost: host,
      logger,
      modelHandler: { getClient: vi.fn() },
      config: { model: 'test-model', agent: 'test-agent' },
      setting: { tools: [] },
      resolvedTools: [],
    } as unknown as ToolUseServices);

    try {
      const result = await withTestRunContext(host, streamId, () =>
        node.exec(createPrepResult(workspaceState)),
      );

      expect(result).toEqual({ outcome: 'skipped' });
      expect(events).toEqual([
        {
          event: 'updateTodos',
          payload: {
            streamId,
            todos: [todo],
          },
        },
        {
          event: 'updatePlan',
          payload: {
            streamId,
            plan,
          },
        },
      ]);
    } finally {
      detachProjection();
      detachTrace();
    }
  });

  it('logs failed cycle outcomes as transcript errors', async () => {
    const workspaceState = AgentWorkspaceState.create();
    const prepRes = createPrepResult(workspaceState);
    const shared: Partial<ToolUseRunShared> = {};
    const error = vi.fn();
    const node = new ToolUseCycleNode().setServices({
      logger: { error },
    } as unknown as ToolUseServices);

    const transition = await node.post(shared as ToolUseRunShared, prepRes, {
      outcome: 'failed',
      message: 'Model claude-opus-4-7 not found',
      userRetryable: false,
    });

    expect(transition).toBe(FlowTransition.DEFAULT);
    expect(shared.lastError).toEqual({
      message: 'Model claude-opus-4-7 not found',
      userRetryable: false,
    });
    expect(error).toHaveBeenCalledWith('Model claude-opus-4-7 not found', {
      messageType: MESSAGE_TYPES.ERROR,
    });
  });
});
