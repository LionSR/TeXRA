import { describe, expect, it } from 'vitest';

import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/execution/AgentWorkspaceState';
import { withToolEnvironment } from '@agent/toolUse/ToolFileInteractionContext';
import {
  TODO_STATUS,
  type Plan,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { PlanTool } from '@tools/plan/PlanTool';
import { TodoWriteTool } from '@tools/todo/TodoTool';
import { createRecordingHost } from '../agent/progressTestUtils';

const todoItem: TodoItem = {
  content: 'Replace ClaudeAgentEffort with SDK effort type',
  activeForm: 'Replacing ClaudeAgentEffort with SDK effort type',
  status: TODO_STATUS.COMPLETED,
};

const overlappingPlan: Plan = {
  summary: 'Replace local Claude SDK type aliases.',
  steps: [
    {
      title: todoItem.content,
      description: 'Use the SDK effort type directly.',
      files: [],
      status: TODO_STATUS.COMPLETED,
    },
    {
      title: 'Verify compilation',
      description: 'Run focused checks.',
      files: [],
      status: TODO_STATUS.IN_PROGRESS,
    },
  ],
};

function callContext(workPlanState: WorkPlanState) {
  return {
    tracker: new FileInteractionState(),
    workPlanState,
  };
}

function runContext() {
  return {
    runtimeHost: createRecordingHost().host,
    streamId: 'stream:work-plan-granularity' as StreamTabId,
  };
}

describe('work plan granularity feedback', () => {
  it('warns when todo_write repeats a plan milestone label', async () => {
    const workPlanState = new WorkPlanState();
    workPlanState.updatePlan(overlappingPlan);

    const result = await withToolEnvironment(
      { run: runContext(), call: callContext(workPlanState) },
      () => new TodoWriteTool().call({ todos: [todoItem] }),
    );

    expect(result.summary).toContain('todo/plan granularity overlap');
    expect(result.output).toContain(
      'Warning: todo_write and plan use the same labels for work at different levels.',
    );
    expect(result.output).toContain(`1. ${todoItem.content}`);
    expect(result.output).toContain(
      'Use plan for long-running goal/odyssey milestones and todo_write for microscopic execution steps.',
    );
    expect(result.output).not.toContain('todo is completed');
    expect(result.output).not.toContain('plan is completed');
    expect(workPlanState.todos).toEqual([todoItem]);
    expect(workPlanState.plan).toEqual(overlappingPlan);
  });

  it('warns when plan repeats a todo label', async () => {
    const workPlanState = new WorkPlanState();
    workPlanState.updateTodos([todoItem]);

    const result = await withToolEnvironment(
      {
        run: runContext(),
        call: callContext(workPlanState),
      },
      () => new PlanTool().call({ command: 'update', plan: overlappingPlan }),
    );

    expect(result.summary).toContain('todo/plan granularity overlap');
    expect(result.output).toContain(
      'Warning: todo_write and plan use the same labels for work at different levels.',
    );
    expect(result.output).toContain(`1. ${todoItem.content}`);
    expect(workPlanState.todos).toEqual([todoItem]);
    expect(workPlanState.plan).toEqual(overlappingPlan);
  });
});
