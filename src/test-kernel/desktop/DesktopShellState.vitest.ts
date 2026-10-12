import { describe, expect, it } from 'vitest';

import {
  DesktopShellStateSchema,
  closeWorkbenchTab,
  initialDesktopShellState,
  openWorkbenchTab,
  setWorkbenchTabDirty,
} from '@desktop/shared/desktopShellState';

describe('desktop document identity', () => {
  it('reopens the same document without discarding unsaved metadata', () => {
    let state = openWorkbenchTab(initialDesktopShellState(), {
      kind: 'editor',
      target: String.raw`C:\papers\draft.tex`,
    });
    const id = state.activeTabId!;
    state = setWorkbenchTabDirty(state, id, true);
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
        dirty: true,
      },
    ]);
  });

  it('does not reuse terminal identities after closure or persistence', () => {
    let state = openWorkbenchTab(initialDesktopShellState(), {
      kind: 'terminal',
    });
    const closedId = state.activeTabId!;
    state = closeWorkbenchTab(state, closedId);
    state = DesktopShellStateSchema.parse(JSON.parse(JSON.stringify(state)));
    state = openWorkbenchTab(state, { kind: 'terminal' });
    expect(state.activeTabId).not.toBe(closedId);
    expect(state.workbenchTabs.some((tab) => tab.id === closedId)).toBe(false);
  });
});
