// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop task shell model
import {
  activeWorkbenchTab,
  BOTTOM_PANEL_MAX_HEIGHT,
  BOTTOM_PANEL_MIN_HEIGHT,
  closeWorkbench,
  closeWorkbenchTab,
  focusWorkbenchTab,
  initialDesktopTaskShellState,
  moveWorkbenchTab,
  openWorkbenchTab,
  PROJECT_SECTION_MAX_POSITION,
  PROJECT_SECTION_MIN_POSITION,
  renameWorkbenchTab,
  reopenWorkbench,
  setBottomPanelHeight,
  setProjectSectionPosition,
  setSidebarWidth,
  setWorkbenchTabDirty,
  setWorkbenchWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleFiles,
  toggleSidebar,
  toggleSummaryBar,
  toggleWorkbench,
  WORKBENCH_KIND_META,
  WORKBENCH_KINDS,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MIN_WIDTH,
  workbenchTab,
  workspaceInitials,
  workspaceName,
  type DesktopTaskShellState,
  type OpenWorkbenchTabRequest,
  type WorkbenchPlacement,
} from '@desktop/shared/desktopTaskShell';

function shellWith(
  ...requests: readonly OpenWorkbenchTabRequest[]
): DesktopTaskShellState {
  return requests.reduce(
    (next, request) => openWorkbenchTab(next, request),
    initialDesktopTaskShellState(),
  );
}

function active(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement = 'right',
): ReturnType<typeof activeWorkbenchTab> {
  return activeWorkbenchTab(state, placement);
}

describe('desktop task shell model', () => {
  it('starts conversation-first with a closed, empty workbench', () => {
    const state = initialDesktopTaskShellState();

    expect(state).toMatchObject({
      activeWorkbenchTabIds: {},
      bottomPanelHeight: 300,
      sidebarCollapsed: false,
      sidebarWidth: 288,
      filesExpanded: true,
      projectSectionPosition: 52,
      summaryBarVisible: true,
      workbenchWidth: 640,
      workbenchTabs: [],
      nextTerminalSerial: 1,
    });
    expect(active(state)).toBeUndefined();
    expect(active(state, 'bottom')).toBeUndefined();
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
    let state = openWorkbenchTab(initialDesktopTaskShellState(), {
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

  it('opens a fresh numbered terminal for every request', () => {
    const state = shellWith(
      { kind: 'terminal', target: '/work' },
      { kind: 'terminal', target: '/work', title: 'Build shell' },
    );

    expect(state.workbenchTabs).toEqual([
      {
        id: 'workbench:terminal:1',
        kind: 'terminal',
        placement: 'bottom',
        title: 'Terminal 1',
        target: '/work',
      },
      {
        id: 'workbench:terminal:2',
        kind: 'terminal',
        placement: 'bottom',
        title: 'Build shell',
        target: '/work',
      },
    ]);
    expect(state.nextTerminalSerial).toBe(3);
    expect(active(state, 'bottom')?.title).toBe('Build shell');
  });

  it('focuses known tabs and ignores unknown ids', () => {
    const state = shellWith({ kind: 'settings' }, { kind: 'logs' });
    const focused = focusWorkbenchTab(state, 'workbench:settings');

    expect(active(focused)?.kind).toBe('settings');
    expect(focusWorkbenchTab(focused, 'missing')).toBe(focused);
    expect(workbenchTab(focused, 'workbench:logs')?.kind).toBe('logs');
  });

  it('closes active tabs toward the left, then the right', () => {
    let state = shellWith(
      { kind: 'settings' },
      { kind: 'logs' },
      { kind: 'editor', target: 'paper.tex' },
    );

    state = closeWorkbenchTab(state, 'workbench:editor:paper.tex');
    expect(active(state)?.kind).toBe('logs');

    state = focusWorkbenchTab(state, 'workbench:settings');
    state = closeWorkbenchTab(state, 'workbench:settings');
    expect(active(state)?.kind).toBe('logs');

    state = closeWorkbenchTab(state, 'workbench:logs');
    expect(active(state)).toBeUndefined();
  });

  it('preserves focus when closing a background tab and ignores unknown ids', () => {
    const state = shellWith({ kind: 'settings' }, { kind: 'logs' });
    const withoutSettings = closeWorkbenchTab(state, 'workbench:settings');

    expect(active(withoutSettings)?.kind).toBe('logs');
    expect(closeWorkbenchTab(withoutSettings, 'missing')).toBe(withoutSettings);
  });

  it('hides the workbench without discarding tabs and reopens the latest tab', () => {
    const openState = shellWith({ kind: 'settings' }, { kind: 'logs' });
    const closed = closeWorkbench(openState, 'right');

    expect(closed.workbenchTabs).toEqual(openState.workbenchTabs);
    expect(active(closed)).toBeUndefined();
    expect(active(reopenWorkbench(closed, 'right'))?.kind).toBe('logs');
    expect(active(toggleWorkbench(closed, 'right'))?.kind).toBe('logs');
    expect(active(toggleWorkbench(openState, 'right'))).toBeUndefined();
    expect(reopenWorkbench(openState, 'right')).toBe(openState);
    expect(reopenWorkbench(initialDesktopTaskShellState(), 'right')).toEqual(
      initialDesktopTaskShellState(),
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
    expect(workbenchTab(state, 'workbench:editor:paper.tex')?.placement).toBe(
      'bottom',
    );

    state = moveWorkbenchTab(state, 'workbench:terminal:1', 'right');
    expect(active(state)?.kind).toBe('terminal');
    expect(active(state, 'bottom')?.kind).toBe('editor');
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

    expect(active(state)).toMatchObject({
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
    const summaryBarHidden = toggleSummaryBar(filesCollapsed);

    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(collapsed.filesExpanded).toBe(initial.filesExpanded);
    expect(filesCollapsed.sidebarCollapsed).toBe(true);
    expect(filesCollapsed.filesExpanded).toBe(false);
    expect(summaryBarHidden.summaryBarVisible).toBe(false);
  });

  it('rounds and clamps sidebar, section, and workbench dimensions', () => {
    const initial = initialDesktopTaskShellState();

    expect(setBottomPanelHeight(initial, 344.6).bottomPanelHeight).toBe(345);
    expect(setBottomPanelHeight(initial, -1).bottomPanelHeight).toBe(
      BOTTOM_PANEL_MIN_HEIGHT,
    );
    expect(setBottomPanelHeight(initial, 10_000).bottomPanelHeight).toBe(
      BOTTOM_PANEL_MAX_HEIGHT,
    );
    expect(setSidebarWidth(initial, 312.7).sidebarWidth).toBe(313);
    expect(setSidebarWidth(initial, -1).sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(setSidebarWidth(initial, 10_000).sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH,
    );
    expect(
      setProjectSectionPosition(initial, 44.6).projectSectionPosition,
    ).toBe(45);
    expect(setProjectSectionPosition(initial, -1).projectSectionPosition).toBe(
      PROJECT_SECTION_MIN_POSITION,
    );
    expect(setProjectSectionPosition(initial, 100).projectSectionPosition).toBe(
      PROJECT_SECTION_MAX_POSITION,
    );
    expect(setWorkbenchWidth(initial, 503.4).workbenchWidth).toBe(503);
    expect(setWorkbenchWidth(initial, -1).workbenchWidth).toBe(
      WORKBENCH_MIN_WIDTH,
    );
    expect(setWorkbenchWidth(initial, 10_000).workbenchWidth).toBe(
      WORKBENCH_MAX_WIDTH,
    );
  });

  it('derives concise workspace labels from POSIX and Windows paths', () => {
    expect(workspaceName('/work/My Paper/')).toBe('My Paper');
    expect(workspaceName(String.raw`C:\work\TeXRA.paper`)).toBe('TeXRA.paper');
    expect(workspaceName(undefined)).toBe('No project open');

    expect(workspaceInitials('/work/My Paper/')).toBe('MP');
    expect(workspaceInitials(String.raw`C:\work\TeXRA.paper`)).toBe('TP');
    expect(workspaceInitials('/work/single')).toBe('S');
    expect(workspaceInitials('/work/.__-')).toBe('TX');
    expect(workspaceInitials(undefined)).toBe('TX');
  });
});
