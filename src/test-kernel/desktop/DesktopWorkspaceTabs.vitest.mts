import { describe, expect, it } from 'vitest';

import {
  activateTab,
  activeTab,
  closeTab,
  initialTabState,
  isClosableTabKind,
  isSingletonTabKind,
  openTab,
  setTabDirty,
  tabIdFor,
  tabKindForRoute,
  WORKSPACE_TAB_ID,
  type DesktopTabState,
} from '@desktop/desktopWorkspaceTabs';

function withTabs(
  ...requests: Parameters<typeof openTab>[1][]
): DesktopTabState {
  return requests.reduce(
    (state, request) => openTab(state, request),
    initialTabState(),
  );
}

describe('desktop workspace tab model', () => {
  it('starts with a single active workspace tab', () => {
    const state = initialTabState();

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(WORKSPACE_TAB_ID);
    expect(activeTab(state).kind).toBe('workspace');
  });

  it('keeps the workspace tab permanent and everything else closable', () => {
    // The workspace tab is the app's home surface; closing it would leave
    // nowhere to return to, so the tab list can never be empty.
    expect(isClosableTabKind('workspace')).toBe(false);
    for (const kind of [
      'editor',
      'terminal',
      'browser',
      'settings',
      'logs',
    ] as const) {
      expect(isClosableTabKind(kind)).toBe(true);
    }
  });

  it('focuses the existing tab instead of duplicating a singleton', () => {
    // Two Settings tabs could render contradictory state for one store.
    expect(isSingletonTabKind('settings')).toBe(true);
    const opened = withTabs({ kind: 'settings' }, { kind: 'settings' });

    expect(opened.tabs.filter((tab) => tab.kind === 'settings')).toHaveLength(
      1,
    );
    expect(opened.activeTabId).toBe('tab:settings');
  });

  it('keys editor tabs by path so reopening one file focuses its tab', () => {
    const state = withTabs(
      { kind: 'editor', target: '/w/main.tex' },
      { kind: 'editor', target: '/w/refs.bib' },
      { kind: 'editor', target: '/w/main.tex' },
    );

    expect(state.tabs.filter((tab) => tab.kind === 'editor')).toHaveLength(2);
    // Re-opening focuses rather than appends — two editors on one file could
    // disagree about its contents.
    expect(state.activeTabId).toBe('tab:editor:/w/main.tex');
  });

  it('titles an editor tab with the file basename', () => {
    const state = withTabs({ kind: 'editor', target: '/w/chapters/intro.tex' });

    expect(activeTab(state).title).toBe('intro.tex');
  });

  it('allows multiple terminals because parallel shells are the point', () => {
    const state = withTabs({ kind: 'terminal' }, { kind: 'terminal' });
    const terminals = state.tabs.filter((tab) => tab.kind === 'terminal');

    expect(terminals).toHaveLength(2);
    expect(terminals.map((tab) => tab.title)).toEqual([
      'Terminal 1',
      'Terminal 2',
    ]);
    expect(state.activeTabId).toBe('tab:terminal:2');
  });

  it('opens one browser tab per URL and focuses a repeat of the same URL', () => {
    // Browser tabs key on their URL, so distinct pages get distinct tabs (the
    // point of a multi-tab browser) while re-opening the same page focuses the
    // tab that already has it loaded.
    const state = withTabs(
      { kind: 'browser', target: 'https://texra.ai/' },
      { kind: 'browser', target: 'https://texra.ai/guide' },
      { kind: 'browser', target: 'https://texra.ai/' },
    );

    expect(state.tabs.filter((tab) => tab.kind === 'browser')).toHaveLength(2);
    expect(state.activeTabId).toBe('tab:browser:https://texra.ai/');
  });

  it('falls back to the left neighbor when closing the active tab', () => {
    const state = withTabs(
      { kind: 'editor', target: '/w/a.tex' },
      { kind: 'editor', target: '/w/b.tex' },
    );
    expect(state.activeTabId).toBe('tab:editor:/w/b.tex');

    const closed = closeTab(state, 'tab:editor:/w/b.tex');

    expect(closed.tabs).toHaveLength(2);
    expect(closed.activeTabId).toBe('tab:editor:/w/a.tex');
  });

  it('does not steal focus when closing a background tab', () => {
    const state = withTabs(
      { kind: 'editor', target: '/w/a.tex' },
      { kind: 'editor', target: '/w/b.tex' },
    );

    const closed = closeTab(state, 'tab:editor:/w/a.tex');

    expect(closed.tabs).toHaveLength(2);
    expect(closed.activeTabId).toBe('tab:editor:/w/b.tex');
  });

  it('refuses to close the workspace tab', () => {
    const state = withTabs({ kind: 'editor', target: '/w/a.tex' });

    expect(closeTab(state, WORKSPACE_TAB_ID)).toBe(state);
  });

  it('ignores close and activate for unknown tab ids', () => {
    const state = withTabs({ kind: 'settings' });

    expect(closeTab(state, 'tab:editor:/nope')).toBe(state);
    expect(activateTab(state, 'tab:editor:/nope')).toBe(state);
  });

  it('tracks a dirty flag for the close guard', () => {
    const state = withTabs({ kind: 'editor', target: '/w/a.tex' });
    const dirty = setTabDirty(state, 'tab:editor:/w/a.tex', true);

    expect(activeTab(dirty).dirty).toBe(true);
    expect(
      activeTab(setTabDirty(dirty, 'tab:editor:/w/a.tex', false)).dirty,
    ).toBe(false);
  });

  it('derives stable ids per request shape', () => {
    expect(tabIdFor({ kind: 'settings' })).toBe('tab:settings');
    expect(tabIdFor({ kind: 'editor', target: '/w/a.tex' })).toBe(
      'tab:editor:/w/a.tex',
    );
  });

  it('maps legacy routes onto the tab that owns each surface', () => {
    // 'main' and 'progress' are two states of the workspace pane (launcher vs
    // conversation), selected by whether a stream is active — not two tabs.
    expect(tabKindForRoute('main')).toBe('workspace');
    expect(tabKindForRoute('progress')).toBe('workspace');
    expect(tabKindForRoute('settings')).toBe('settings');
    expect(tabKindForRoute('logs')).toBe('logs');
  });
});
