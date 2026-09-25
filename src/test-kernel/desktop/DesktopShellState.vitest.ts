// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop shell state model
import {
  activeWorkbenchTab,
  initialDesktopShellState,
  openWorkbenchTab,
  type DesktopShellState,
  type OpenWorkbenchTabRequest,
  type WorkbenchPlacement,
} from '@desktop/shared/desktopShellState';

function shellWith(
  ...requests: readonly OpenWorkbenchTabRequest[]
): DesktopShellState {
  return requests.reduce(
    (next, request) => openWorkbenchTab(next, request),
    initialDesktopShellState(),
  );
}

function active(
  state: DesktopShellState,
  placement: WorkbenchPlacement = 'right',
): ReturnType<typeof activeWorkbenchTab> {
  return activeWorkbenchTab(state, placement);
}

describe('desktop shell state model', () => {
  it('keys editors by path and derives cross-platform basenames', () => {
    const state = shellWith(
      { kind: 'editor', target: '/papers/first.tex' },
      { kind: 'editor', target: String.raw`C:\papers\second.tex` },
    );

    expect(state.workbenchTabs).toEqual([
      {
        id: 'workbench:editor:/papers/first.tex',
        kind: 'editor',
        placement: 'right',
        title: 'first.tex',
        target: '/papers/first.tex',
      },
      {
        id: String.raw`workbench:editor:C:\papers\second.tex`,
        kind: 'editor',
        placement: 'right',
        title: 'second.tex',
        target: String.raw`C:\papers\second.tex`,
      },
    ]);
    expect(active(state)?.title).toBe('second.tex');
  });

  it('replaces the generic editor placeholder when a file opens', () => {
    let state = openWorkbenchTab(initialDesktopShellState(), {
      kind: 'editor',
      placement: 'bottom',
    });
    expect(state.workbenchTabs.map((tab) => tab.id)).toEqual([
      'workbench:editor',
    ]);

    state = openWorkbenchTab(state, {
      kind: 'editor',
      target: 'paper.tex',
    });

    expect(state.workbenchTabs.map((tab) => tab.id)).toEqual([
      'workbench:editor:paper.tex',
    ]);
    expect(state.activeWorkbenchTabIds.bottom).toBeUndefined();
    expect(state.activeWorkbenchTabIds.right).toBe(
      'workbench:editor:paper.tex',
    );
  });

  it('focuses existing singleton and editor tabs without duplicating them', () => {
    let state = shellWith(
      { kind: 'settings' },
      { kind: 'editor', target: 'paper.tex' },
      { kind: 'logs' },
    );

    state = openWorkbenchTab(state, {
      kind: 'settings',
      title: 'Ignored replacement title',
    });
    state = openWorkbenchTab(state, {
      kind: 'editor',
      target: 'paper.tex',
    });

    expect(state.workbenchTabs).toHaveLength(3);
    expect(
      state.workbenchTabs.filter((tab) => tab.kind === 'settings'),
    ).toHaveLength(1);
    expect(active(state)?.id).toBe('workbench:editor:paper.tex');
  });
});
