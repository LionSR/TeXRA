import { strict as assert } from 'node:assert';

import { describe, expect, it } from 'vitest';

import {
  initialDesktopShellState,
  openWorkbenchTab,
} from '@desktop/shared/desktopShellState';

describe('desktop document identity', () => {
  it('reopens the same document in its tab', () => {
    let state = openWorkbenchTab(initialDesktopShellState(), {
      kind: 'editor',
      target: String.raw`C:\papers\draft.tex`,
    });
    const id = state.activeTabId;
    assert(id !== undefined);
    state = openWorkbenchTab(state, { kind: 'files' });
    state = openWorkbenchTab(state, {
      kind: 'editor',
      target: String.raw`C:\papers\draft.tex`,
    });
    expect(state.activeTabId).toBe(id);
    expect(state.workbenchTabs.filter((tab) => tab.kind === 'editor')).toEqual([
      {
        id,
        kind: 'editor',
        target: String.raw`C:\papers\draft.tex`,
        title: 'draft.tex',
      },
    ]);
  });
});
