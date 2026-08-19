// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentWorkspaceState,
  FileInteractionState,
} from '@agent/core/state/AgentWorkspaceState';

describe('agent workspace work-plan state', () => {
  it.each([
    ['a snapshot without workPlan', {}],
    ['a null workPlan', { workPlan: null }],
    [
      'invalid current workPlan entries',
      { workPlan: { todos: [{ content: 'Missing status and active form' }] } },
    ],
  ])('rejects %s', (_name, snapshot) => {
    expect(() => AgentWorkspaceState.fromSnapshot(snapshot)).toThrow();
  });

  it('round-trips the canonical work-plan snapshot', () => {
    const state = AgentWorkspaceState.create();
    const snapshot = state.toSnapshot();

    expect(AgentWorkspaceState.fromSnapshot(snapshot).toSnapshot()).toEqual(
      snapshot,
    );
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
