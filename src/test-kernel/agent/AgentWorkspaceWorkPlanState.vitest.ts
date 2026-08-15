// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentWorkspaceState,
  FileInteractionState,
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

describe('agent workspace file-interaction state', () => {
  it('round-trips edit paths and line counts through the workspace snapshot', () => {
    const state = AgentWorkspaceState.create();
    state.interactions.recordEdits([
      { path: 'paper.tex', lineChanges: { added: 3, removed: 1 } },
      { path: 'notes.md', lineChanges: { added: 2, removed: 5 } },
    ]);

    const snapshot = state.toSnapshot();
    expect(snapshot.interactions.edits).toEqual([
      { path: 'paper.tex', added: 3, removed: 1 },
      { path: 'notes.md', added: 2, removed: 5 },
    ]);

    const rehydrated = AgentWorkspaceState.fromCanonicalSnapshot(snapshot);
    expect(rehydrated.interactions.editedFilePaths).toEqual([
      'paper.tex',
      'notes.md',
    ]);

    const merged = rehydrated.interactions.recordEdits([
      { path: 'paper.tex', lineChanges: { added: 1, removed: 0 } },
    ]);
    expect(merged.lineChanges).toEqual({ added: 1, removed: 0 });
    expect(rehydrated.interactions.toSnapshot().edits).toEqual([
      { path: 'paper.tex', added: 4, removed: 1 },
      { path: 'notes.md', added: 2, removed: 5 },
    ]);
  });

  it('prefaults missing added/removed on persisted file-edit snapshots', () => {
    const state = FileInteractionState.fromSnapshot({
      edits: [{ path: 'legacy.md' }],
    });

    expect(state.editedFilePaths).toEqual(['legacy.md']);
    expect(state.toSnapshot()).toEqual({
      readFiles: [],
      edits: [{ path: 'legacy.md', added: 0, removed: 0 }],
      toolCallCount: 0,
    });
  });
});
