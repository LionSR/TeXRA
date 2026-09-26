// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';

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

    const rehydrated = AgentWorkspaceState.fromSnapshot(snapshot);
    expect(rehydrated.interactions.editedFilePaths).toEqual([
      'paper.tex',
      'notes.md',
    ]);

    rehydrated.interactions.recordEdits([
      { path: 'paper.tex', lineChanges: { added: 1, removed: 0 } },
    ]);
    expect(rehydrated.interactions.toSnapshot().edits).toEqual([
      { path: 'paper.tex', added: 4, removed: 1 },
      { path: 'notes.md', added: 2, removed: 5 },
    ]);
  });
});
