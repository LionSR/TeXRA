// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentWorkspaceState,
  type AgentWorkspaceSnapshot,
} from '@agent/core/state/AgentWorkspaceState';
import type { TodoItem } from '@shared/schemas';

const todo: TodoItem = {
  content: 'Consolidate plan and todo state',
  status: 'in_progress',
  activeForm: 'Consolidating plan and todo state',
};

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
  it.each([
    {
      name: 'a retired structured plan',
      snapshot: { todos: { todos: [todo] }, plan: { plan: legacyPlan } },
    },
    {
      name: 'a retired structured plan hidden behind a null workPlan',
      snapshot: {
        workPlan: null,
        todos: { todos: [todo] },
        plan: { plan: legacyPlan },
      },
    },
    {
      name: 'invalid legacy todo entries instead of clearing them',
      snapshot: {
        todos: { todos: [{ content: 'Missing status and active form' }] },
      },
    },
    {
      name: 'a bare legacy todo object without a wrapper key',
      snapshot: { todos: { content: 'Missing wrapper key' } },
    },
    {
      name: 'invalid current workPlan entries instead of falling back to legacy fields',
      snapshot: {
        workPlan: { todos: [{ content: 'Missing status and active form' }] },
      },
    },
  ])('rejects $name', ({ snapshot }) => {
    expect(() => AgentWorkspaceState.fromSnapshot(snapshot)).toThrow();
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
    expect(state.workPlan.planSummary).toBe(objectivePlan.objective);
  });

  it('confines legacy todo/plan migration to the boundary hydration path', () => {
    const legacySnapshot = {
      todos: { todos: [todo] },
      plan: { plan: objectivePlan },
    };

    // Regression: the single hydration boundary (session-init resume in
    // ToolUsePrepareNode, reflection resume in runReflectionFlow) must keep
    // migrating a persisted legacy record.
    const hydrated = AgentWorkspaceState.fromSnapshot(legacySnapshot);
    expect(hydrated.workPlan.todos).toEqual([todo]);
    expect(hydrated.workPlan.plan).toEqual(objectivePlan);
    expect(hydrated.workPlan.planSummary).toBe(objectivePlan.objective);

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
    expect(rehydrated.workPlan.plan).toEqual(objectivePlan);
  });
});
