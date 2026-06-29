// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { TodoItem } from '@shared/schemas';
import { formatPostCompactionContext } from '@tools/subagentResults';

const todo: TodoItem = {
  content: 'Consolidate plan and todo state',
  status: 'in_progress',
  activeForm: 'Consolidating plan and todo state',
};

// Pre-June-2026 structured plan shape, kept verbatim: persisted snapshots may
// still carry it. It deliberately fails to parse against the current
// {objective} document schema and reads back as "no plan".
const legacyPlan = {
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
      plan: { plan: legacyPlan },
    });

    // Todos survive the legacy two-store layout; the legacy structured plan
    // does not parse as an {objective} document, so it reads back as null.
    expect(state.workPlan.todos).toEqual([todo]);
    expect(state.workPlan.plan).toBeNull();

    const snapshot = state.toSnapshot();
    expect(Object.hasOwn(snapshot, 'todos')).toBe(false);
    expect(Object.hasOwn(snapshot, 'plan')).toBe(false);
    expect(snapshot.workPlan).toEqual({
      todos: [todo],
      plan: null,
      planSummary: null,
    });
  });

  it('keeps the stored summary line visible after compaction when only a legacy plan remains', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      workPlan: {
        todos: [],
        plan: legacyPlan,
        planSummary: legacyPlan.summary,
      },
    });

    // The legacy plan document is gone, but its persisted one-line summary
    // still labels the work after a restore.
    expect(state.workPlan.plan).toBeNull();
    expect(state.workPlan.planSummary).toBe(legacyPlan.summary);

    const context = formatPostCompactionContext(
      [],
      [],
      state.workPlan.toSnapshot(),
    );

    expect(context).toContain('<current-plan>');
    expect(context).toContain(legacyPlan.summary);

    state.workPlan.updatePlan(null);

    expect(state.workPlan.planSummary).toBeNull();
    expect(
      formatPostCompactionContext([], [], state.workPlan.toSnapshot()) ?? '',
    ).not.toContain('<current-plan');
  });
});
