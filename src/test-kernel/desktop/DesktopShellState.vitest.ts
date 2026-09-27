// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop shell state model
import {
  activeWorkbenchTab,
  closeWorkbench,
  closeWorkbenchTab,
  focusWorkbenchTab,
  initialDesktopShellState,
  moveWorkbenchTab,
  openWorkbenchTab,
  toggleWorkbench,
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
      { kind: 'browser' },
      { kind: 'editor', target: 'paper.tex' },
      { kind: 'logs' },
    );

    state = openWorkbenchTab(state, {
      kind: 'browser',
      title: 'Ignored replacement title',
    });
    state = openWorkbenchTab(state, {
      kind: 'editor',
      target: 'paper.tex',
    });

    expect(state.workbenchTabs).toHaveLength(3);
    expect(
      state.workbenchTabs.filter((tab) => tab.kind === 'browser'),
    ).toHaveLength(1);
    expect(active(state)?.id).toBe('workbench:editor:paper.tex');
  });

  it('closes active tabs toward the left, then the right', () => {
    let state = shellWith(
      { kind: 'browser' },
      { kind: 'logs' },
      { kind: 'editor', target: 'paper.tex' },
    );

    state = closeWorkbenchTab(state, 'workbench:editor:paper.tex');
    expect(active(state)?.kind).toBe('logs');

    state = focusWorkbenchTab(state, 'workbench:browser');
    state = closeWorkbenchTab(state, 'workbench:browser');
    expect(active(state)?.kind).toBe('logs');

    state = closeWorkbenchTab(state, 'workbench:logs');
    expect(active(state)).toBeUndefined();
  });

  it('hides the workbench without discarding tabs and reopens the latest tab', () => {
    const openState = shellWith({ kind: 'browser' }, { kind: 'logs' });
    const closed = closeWorkbench(openState, 'right');

    expect(closed.workbenchTabs).toEqual(openState.workbenchTabs);
    expect(active(closed)).toBeUndefined();
    expect(active(toggleWorkbench(closed, 'right'))?.kind).toBe('logs');
    expect(active(toggleWorkbench(openState, 'right'))).toBeUndefined();
    expect(toggleWorkbench(initialDesktopShellState(), 'right')).toEqual(
      initialDesktopShellState(),
    );
  });

  it('places terminal tabs at the bottom and moves any tab between panes', () => {
    let state = shellWith(
      { kind: 'editor', target: 'paper.tex' },
      { kind: 'terminal', target: '/work' },
    );

    expect(active(state)?.kind).toBe('editor');
    expect(active(state, 'bottom')?.kind).toBe('terminal');

    state = moveWorkbenchTab(state, 'workbench:editor:paper.tex', 'bottom');
    expect(active(state)).toBeUndefined();
    expect(active(state, 'bottom')?.kind).toBe('editor');

    state = moveWorkbenchTab(state, 'workbench:terminal:1', 'right');
    expect(active(state)?.kind).toBe('terminal');
    expect(active(state, 'bottom')?.kind).toBe('editor');
  });
});
