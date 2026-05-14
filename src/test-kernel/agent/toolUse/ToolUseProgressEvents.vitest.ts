// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ToolUseCycleNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseCycleNode';
import type { CyclePrepResult } from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { Plan, TodoItem } from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

const todo: TodoItem = {
  content: 'Wire progress events through runtime host',
  status: 'in_progress',
  activeForm: 'Wiring progress events',
};

const plan: Plan = {
  summary: 'Move progress publication behind the runtime host',
  steps: [
    {
      title: 'Replace bus events',
      description: 'Publish tool-use cycle state through runtimeHost',
      status: 'in_progress',
      files: [],
    },
  ],
};

function createPrepResult(
  workspaceState: AgentWorkspaceState,
): CyclePrepResult {
  return {
    shouldSkip: true,
    messages: [],
    runState: { totalRounds: 0 } as CyclePrepResult['runState'],
    workspaceState,
    userChannels: {} as CyclePrepResult['userChannels'],
  };
}

describe('tool-use progress events', () => {
  it('publishes skipped-cycle todo and plan events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const workspaceState = AgentWorkspaceState.create();
    workspaceState.workPlan.updateTodos([todo]);
    workspaceState.workPlan.updatePlan(plan);

    const node = new ToolUseCycleNode().setServices({
      streamId: 'stream:tool-use-cycle',
      runtimeHost: host,
      modelHandler: { getClient: vi.fn() },
      config: { model: 'test-model', agent: 'test-agent' },
      setting: { tools: [] },
      resolvedTools: [],
    } as unknown as ToolUseServices);

    const result = await node.exec(createPrepResult(workspaceState));

    expect(result).toEqual({ outcome: 'skipped' });
    expect(events).toEqual([
      {
        event: 'updateTodos',
        payload: {
          streamId: 'stream:tool-use-cycle',
          todos: [todo],
        },
      },
      {
        event: 'updatePlan',
        payload: {
          streamId: 'stream:tool-use-cycle',
          plan,
        },
      },
    ]);
  });
});
