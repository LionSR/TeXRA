// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { Plan, TodoItem } from '@shared/schemas';
import { formatPostCompactionContext } from '@tools/subagentResults';

const todo: TodoItem = {
  content: 'Consolidate plan and todo state',
  status: 'in_progress',
  activeForm: 'Consolidating plan and todo state',
};

const plan: Plan = {
  summary: 'Use one workspace owner for plan and todo progress.',
  steps: [
    {
      title: 'Introduce owner',
      description: 'Move plan and todo progress behind WorkPlanState.',
      status: 'pending',
      files: ['src/agent/core/AgentWorkspaceState.ts'],
    },
  ],
};

describe('agent workspace work-plan state', () => {
  it('migrates legacy todo and plan snapshots into the current workPlan shape', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      todos: { todos: [todo] },
      plan: { plan },
    });

    expect(state.workPlan.todos).toEqual([todo]);
    expect(state.workPlan.plan).toEqual(plan);

    const snapshot = state.toSnapshot();
    expect(Object.hasOwn(snapshot, 'todos')).toBe(false);
    expect(Object.hasOwn(snapshot, 'plan')).toBe(false);
    expect(snapshot.workPlan).toEqual({
      todos: [todo],
      plan,
      planSummary: plan.summary,
    });
  });

  it('keeps a legacy summary-only plan visible after compaction', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      plan: {
        plan: {
          summary: 'Retain the plan summary even when no steps remain.',
          steps: [],
        },
      },
    });

    expect(state.workPlan.plan).toBeNull();
    expect(state.workPlan.planSummary).toBe(
      'Retain the plan summary even when no steps remain.',
    );

    const context = formatPostCompactionContext(
      [],
      [],
      state.workPlan.toSnapshot(),
    );

    expect(context).toContain(
      '<current-plan summary="Retain the plan summary even when no steps remain.">',
    );
    expect(context).not.toContain('<step ');

    state.workPlan.updatePlan(null);

    expect(state.workPlan.planSummary).toBeNull();
    expect(
      formatPostCompactionContext([], [], state.workPlan.toSnapshot()) ?? '',
    ).not.toContain('<current-plan');
  });
});
