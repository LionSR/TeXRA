// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop task shell model
import {
  activeWorkbenchTab,
  closeWorkbench,
  closeWorkbenchTab,
  focusWorkbenchTab,
  initialDesktopTaskShellState,
  openWorkbenchTab,
  renameWorkbenchTab,
  reopenWorkbench,
  setSidebarWidth,
  setWorkbenchTabDirty,
  setWorkbenchWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleFiles,
  toggleSidebar,
  WORKBENCH_KIND_META,
  WORKBENCH_KINDS,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MIN_WIDTH,
  workbenchKindForRoute,
  workbenchTab,
  workspaceInitials,
  workspaceName,
  type DesktopTaskShellState,
  type OpenWorkbenchTabRequest,
} from '@desktop/desktopTaskShell';

function open(
  state: DesktopTaskShellState,
  ...requests: readonly OpenWorkbenchTabRequest[]
): DesktopTaskShellState {
  return requests.reduce(
    (next, request) => openWorkbenchTab(next, request),
    state,
  );
}

describe('desktop task shell model', () => {
  it('starts conversation-first with a closed, empty workbench', () => {
    const state = initialDesktopTaskShellState();

    expect(state).toMatchObject({
      sidebarCollapsed: false,
      sidebarWidth: 288,
      filesExpanded: true,
      workbenchWidth: 640,
      workbenchTabs: [],
      nextTerminalSerial: 1,
    });
    expect(activeWorkbenchTab(state)).toBeUndefined();
  });

  it('describes every workbench kind for one renderer path', () => {
    expect(Object.keys(WORKBENCH_KIND_META).sort()).toEqual(
      [...WORKBENCH_KINDS].sort(),
    );
    for (const kind of WORKBENCH_KINDS) {
      expect(WORKBENCH_KIND_META[kind].label).toBeTruthy();
      expect(WORKBENCH_KIND_META[kind].icon).toBeTruthy();
    }
  });

  it('keys editors by path and derives cross-platform basenames', () => {
    const state = open(
      initialDesktopTaskShellState(),
      { kind: 'editor', target: '/papers/first.tex' },
      { kind: 'editor', target: String.raw`C:\papers\second.tex` },
    );

    expect(state.workbenchTabs).toEqual([
      {
        id: 'workbench:editor:/papers/first.tex',
        kind: 'editor',
        title: 'first.tex',
        target: '/papers/first.tex',
      },
      {
        id: String.raw`workbench:editor:C:\papers\second.tex`,
        kind: 'editor',
        title: 'second.tex',
        target: String.raw`C:\papers\second.tex`,
      },
    ]);
    expect(activeWorkbenchTab(state)?.title).toBe('second.tex');
  });

  it('replaces the generic editor placeholder when a file opens', () => {
    let state = openWorkbenchTab(initialDesktopTaskShellState(), {
      kind: 'editor',
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
  });

  it('focuses existing singleton and editor tabs without duplicating them', () => {
    let state = open(
      initialDesktopTaskShellState(),
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
    expect(activeWorkbenchTab(state)?.id).toBe('workbench:editor:paper.tex');
  });

  it('opens a fresh numbered terminal for every request', () => {
    const state = open(
      initialDesktopTaskShellState(),
      { kind: 'terminal', target: '/work' },
      { kind: 'terminal', target: '/work', title: 'Build shell' },
    );

    expect(state.workbenchTabs).toEqual([
      {
        id: 'workbench:terminal:1',
        kind: 'terminal',
        title: 'Terminal 1',
        target: '/work',
      },
      {
        id: 'workbench:terminal:2',
        kind: 'terminal',
        title: 'Build shell',
        target: '/work',
      },
    ]);
    expect(state.nextTerminalSerial).toBe(3);
  });

  it('focuses known tabs and ignores unknown ids', () => {
    const state = open(
      initialDesktopTaskShellState(),
      { kind: 'settings' },
      { kind: 'logs' },
    );
    const focused = focusWorkbenchTab(state, 'workbench:settings');

    expect(activeWorkbenchTab(focused)?.kind).toBe('settings');
    expect(focusWorkbenchTab(focused, 'missing')).toBe(focused);
    expect(workbenchTab(focused, 'workbench:logs')?.kind).toBe('logs');
  });

  it('closes active tabs toward the left, then the right', () => {
    let state = open(
      initialDesktopTaskShellState(),
      { kind: 'settings' },
      { kind: 'logs' },
      { kind: 'editor', target: 'paper.tex' },
    );

    state = closeWorkbenchTab(state, 'workbench:editor:paper.tex');
    expect(activeWorkbenchTab(state)?.kind).toBe('logs');

    state = focusWorkbenchTab(state, 'workbench:settings');
    state = closeWorkbenchTab(state, 'workbench:settings');
    expect(activeWorkbenchTab(state)?.kind).toBe('logs');

    state = closeWorkbenchTab(state, 'workbench:logs');
    expect(activeWorkbenchTab(state)).toBeUndefined();
  });

  it('preserves focus when closing a background tab and ignores unknown ids', () => {
    const state = open(
      initialDesktopTaskShellState(),
      { kind: 'settings' },
      { kind: 'logs' },
    );
    const withoutSettings = closeWorkbenchTab(state, 'workbench:settings');

    expect(activeWorkbenchTab(withoutSettings)?.kind).toBe('logs');
    expect(closeWorkbenchTab(withoutSettings, 'missing')).toBe(withoutSettings);
  });

  it('hides the workbench without discarding tabs and reopens the latest tab', () => {
    const openState = open(
      initialDesktopTaskShellState(),
      { kind: 'settings' },
      { kind: 'logs' },
    );
    const closed = closeWorkbench(openState);

    expect(closed.workbenchTabs).toEqual(openState.workbenchTabs);
    expect(activeWorkbenchTab(closed)).toBeUndefined();
    expect(activeWorkbenchTab(reopenWorkbench(closed))?.kind).toBe('logs');
    expect(reopenWorkbench(openState)).toBe(openState);
    expect(reopenWorkbench(initialDesktopTaskShellState())).toEqual(
      initialDesktopTaskShellState(),
    );
  });

  it('normalizes titles and tracks dirty state on known tabs', () => {
    let state = openWorkbenchTab(initialDesktopTaskShellState(), {
      kind: 'editor',
      target: 'paper.tex',
    });
    state = renameWorkbenchTab(
      state,
      'workbench:editor:paper.tex',
      '  Main paper  ',
    );
    state = setWorkbenchTabDirty(state, 'workbench:editor:paper.tex', true);

    expect(activeWorkbenchTab(state)).toMatchObject({
      title: 'Main paper',
      dirty: true,
    });
    expect(renameWorkbenchTab(state, 'workbench:editor:paper.tex', '   ')).toBe(
      state,
    );
    expect(setWorkbenchTabDirty(state, 'missing', true)).toBe(state);
  });

  it('toggles sidebar sections independently', () => {
    const initial = initialDesktopTaskShellState();
    const collapsed = toggleSidebar(initial);
    const filesCollapsed = toggleFiles(collapsed);

    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(collapsed.filesExpanded).toBe(initial.filesExpanded);
    expect(filesCollapsed.sidebarCollapsed).toBe(true);
    expect(filesCollapsed.filesExpanded).toBe(false);
  });

  it('rounds and clamps sidebar and workbench widths', () => {
    const initial = initialDesktopTaskShellState();

    expect(setSidebarWidth(initial, 312.7).sidebarWidth).toBe(313);
    expect(setSidebarWidth(initial, -1).sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(setSidebarWidth(initial, 10_000).sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH,
    );
    expect(setWorkbenchWidth(initial, 503.4).workbenchWidth).toBe(503);
    expect(setWorkbenchWidth(initial, -1).workbenchWidth).toBe(
      WORKBENCH_MIN_WIDTH,
    );
    expect(setWorkbenchWidth(initial, 10_000).workbenchWidth).toBe(
      WORKBENCH_MAX_WIDTH,
    );
  });

  it('maps only artifact routes into the workbench', () => {
    expect(workbenchKindForRoute('settings')).toBe('settings');
    expect(workbenchKindForRoute('logs')).toBe('logs');
    expect(workbenchKindForRoute('main')).toBeUndefined();
    expect(workbenchKindForRoute('progress')).toBeUndefined();
  });

  it('derives concise workspace labels from POSIX and Windows paths', () => {
    expect(workspaceName('/work/My Paper/')).toBe('My Paper');
    expect(workspaceName(String.raw`C:\work\TeXRA.paper`)).toBe('TeXRA.paper');
    expect(workspaceName(undefined)).toBe('No project open');

    expect(workspaceInitials('/work/My Paper/')).toBe('MP');
    expect(workspaceInitials(String.raw`C:\work\TeXRA.paper`)).toBe('TP');
    expect(workspaceInitials('/work/single')).toBe('S');
    expect(workspaceInitials(undefined)).toBe('TX');
  });
});
