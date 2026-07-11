// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentWorkspaceState,
  type AgentWorkspaceSnapshot,
} from '@agent/core/state/AgentWorkspaceState';
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

const objectivePlan = {
  objective: 'Use one workspace owner for plan and todo progress.',
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

  it('migrates legacy todo and plan snapshots when workPlan is null', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      workPlan: null,
      todos: { todos: [todo] },
      plan: { plan: legacyPlan },
    });

    expect(state.workPlan.todos).toEqual([todo]);
    expect(state.workPlan.plan).toBeNull();
  });

  it('rejects invalid legacy todo entries instead of clearing them', () => {
    expect(() =>
      AgentWorkspaceState.fromSnapshot({
        todos: {
          todos: [
            {
              content: 'Missing status and active form',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('treats legacy null todos as absent', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      todos: null,
    });

    expect(state.workPlan.todos).toEqual([]);
  });

  it('preserves a bare legacy plan document without a wrapper key', () => {
    const state = AgentWorkspaceState.fromSnapshot({
      plan: objectivePlan,
    });

    expect(state.workPlan.plan).toEqual(objectivePlan);
  });

  it('rejects a bare legacy todo object without a wrapper key', () => {
    expect(() =>
      AgentWorkspaceState.fromSnapshot({
        todos: {
          content: 'Missing wrapper key',
        },
      }),
    ).toThrow();
  });

  it('rejects invalid current workPlan entries instead of falling back to legacy fields', () => {
    expect(() =>
      AgentWorkspaceState.fromSnapshot({
        workPlan: {
          todos: [
            {
              content: 'Missing status and active form',
            },
          ],
        },
      }),
    ).toThrow();
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

  it('confines legacy todo/plan migration to the boundary hydration path', () => {
    const legacySnapshot = {
      todos: { todos: [todo] },
      plan: { plan: legacyPlan },
    };

    // Regression: the single hydration boundary (session-init resume in
    // ToolUsePrepareNode, reflection resume in runReflectionFlow) must keep
    // migrating a persisted legacy record.
    const hydrated = AgentWorkspaceState.fromSnapshot(legacySnapshot);
    expect(hydrated.workPlan.todos).toEqual([todo]);
    expect(hydrated.workPlan.plan).toBeNull();

    // Per-round node prep (ToolUseCycleNode, ResponseCycleNode,
    // MediaExtractionNode) only ever rehydrates this run's own canonical
    // toSnapshot() output via fromCanonicalSnapshot, which takes the
    // canonical type and must never fall back to the legacy shape — a
    // legacy-shaped record reaching it is corruption, not a format to
    // silently migrate.
    expect(() =>
      AgentWorkspaceState.fromCanonicalSnapshot(
        legacySnapshot as unknown as AgentWorkspaceSnapshot,
      ),
    ).toThrow();

    // The canonical round-trip (toSnapshot -> fromCanonicalSnapshot) that
    // every subsequent round actually exercises keeps working.
    const canonicalSnapshot = hydrated.toSnapshot();
    const rehydrated =
      AgentWorkspaceState.fromCanonicalSnapshot(canonicalSnapshot);
    expect(rehydrated.workPlan.todos).toEqual([todo]);
    expect(rehydrated.workPlan.plan).toBeNull();
  });
});
