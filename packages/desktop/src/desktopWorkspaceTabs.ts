// Tab model for the desktop workspace shell.
//
// The shell used to be four mutually exclusive routes ('main' | 'progress' |
// 'settings' | 'logs') where Settings and Logs were modal overlays. That forced
// a choice the desktop app shouldn't impose: reading Settings meant covering
// the run you were configuring, and there was nowhere to put a persistent
// editor, terminal, or browser.
//
// This module owns the tab kinds and the pure reducer over them. It is
// deliberately host-neutral and free of Electron and DOM imports so the
// reducer can be unit-tested directly.
//
// `DesktopRoute` is NOT replaced: it stays the wire format for menu and
// command-palette IPC (`desktop:setRoute`). {@link tabKindForRoute} maps a
// legacy route onto the tab that now owns that surface.

import { z } from 'zod';

import type { TeXRAIconName } from '@shared/wa/webAwesomeIcons';

/**
 * Tab kinds.
 *
 * - `workspace` — the launcher + conversation pane. Singleton and permanent:
 *   it is the app's home surface and closing it would leave nothing to return
 *   to, so {@link isClosableTabKind} excludes it.
 * - `editor` — one file open in Monaco. Multi-instance, keyed by file path.
 * - `terminal` — an interactive shell. Multi-instance; several are useful
 *   (build in one, git in another).
 * - `browser` — embedded web content, rendered by a main-process
 *   WebContentsView rather than in the renderer.
 * - `settings` / `logs` — singletons, promoted from overlays to real tabs.
 */
const DESKTOP_TAB_KINDS = [
  'workspace',
  'editor',
  'terminal',
  'browser',
  'settings',
  'logs',
] as const;

const DesktopTabKindSchema = z.enum(DESKTOP_TAB_KINDS);
export type DesktopTabKind = z.infer<typeof DesktopTabKindSchema>;

/**
 * Kinds limited to a single instance. Opening one again focuses the existing
 * tab instead of stacking duplicates — two Settings tabs could show
 * contradictory state for the same underlying store.
 */
const SINGLETON_TAB_KINDS = new Set<DesktopTabKind>([
  'workspace',
  'settings',
  'logs',
]);

export function isSingletonTabKind(kind: DesktopTabKind): boolean {
  return SINGLETON_TAB_KINDS.has(kind);
}

/** Every tab except `workspace` can be closed. */
export function isClosableTabKind(kind: DesktopTabKind): boolean {
  return kind !== 'workspace';
}

export const WORKSPACE_TAB_ID = 'tab:workspace';

/**
 * An open tab. A plain interface rather than a Zod schema: this is in-memory
 * renderer state, never parsed from a wire message or persisted, so there is no
 * untrusted input to validate. The kind union is still derived from a Zod enum
 * so the icon and title records stay exhaustive by construction.
 */
export interface DesktopTab {
  readonly id: string;
  readonly kind: DesktopTabKind;
  readonly title: string;
  /**
   * Icon for the tab strip. Typed as the shared icon-name union so an
   * unregistered name is a compile error, not a blank icon at runtime.
   */
  readonly icon: TeXRAIconName;
  /**
   * Kind-specific target: absolute file path for `editor`, URL for `browser`,
   * working directory for `terminal`. Absent for singleton kinds, which have
   * nothing to disambiguate.
   */
  readonly target?: string;
  /** Set when the tab holds unsaved work; drives the dirty dot + close guard. */
  readonly dirty?: boolean;
}

export interface DesktopTabState {
  readonly tabs: readonly DesktopTab[];
  readonly activeTabId: string;
}

const TAB_KIND_ICONS = {
  workspace: 'wand-magic-sparkles',
  editor: 'file-code',
  terminal: 'terminal',
  browser: 'globe',
  settings: 'gear',
  logs: 'file-lines',
} as const satisfies Record<DesktopTabKind, TeXRAIconName>;

const TAB_KIND_TITLES: Record<DesktopTabKind, string> = {
  workspace: 'Workspace',
  editor: 'Editor',
  terminal: 'Terminal',
  browser: 'Browser',
  settings: 'Settings',
  logs: 'Logs',
};

export function initialTabState(): DesktopTabState {
  return {
    tabs: [
      {
        id: WORKSPACE_TAB_ID,
        kind: 'workspace',
        title: TAB_KIND_TITLES.workspace,
        icon: TAB_KIND_ICONS.workspace,
      },
    ],
    activeTabId: WORKSPACE_TAB_ID,
  };
}

/**
 * Basename for an editor tab title. Kept local rather than shared with the
 * shell's workspace-directory label: that one falls back to 'No folder' for
 * empty input, which would be wrong on a tab.
 */
function basename(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').findLast(Boolean) ?? filePath;
}

export interface OpenTabRequest {
  readonly kind: DesktopTabKind;
  readonly target?: string;
  readonly title?: string;
}

/**
 * Stable id for a tab request. Singletons key on kind alone; targeted kinds
 * include the target so reopening the same file focuses the existing tab
 * rather than opening a second view of one file (which would let two editors
 * disagree about its contents).
 */
export function tabIdFor(request: OpenTabRequest): string {
  if (isSingletonTabKind(request.kind)) return `tab:${request.kind}`;
  return request.target
    ? `tab:${request.kind}:${request.target}`
    : `tab:${request.kind}`;
}

function titleFor(request: OpenTabRequest): string {
  if (request.title) return request.title;
  if (request.kind === 'editor' && request.target) {
    return basename(request.target);
  }
  return TAB_KIND_TITLES[request.kind];
}

/**
 * Opens a tab, or focuses it when already present. Terminals are the one kind
 * that intentionally allows duplicates for the same target, so they get a
 * counter suffix.
 */
export function openTab(
  state: DesktopTabState,
  request: OpenTabRequest,
): DesktopTabState {
  if (request.kind === 'terminal') {
    const count =
      state.tabs.filter((tab) => tab.kind === 'terminal').length + 1;
    const tab: DesktopTab = {
      id: `tab:terminal:${count}`,
      kind: 'terminal',
      title: request.title ?? `Terminal ${count}`,
      icon: TAB_KIND_ICONS.terminal,
      ...(request.target ? { target: request.target } : {}),
    };
    return { tabs: [...state.tabs, tab], activeTabId: tab.id };
  }

  // Targeted kinds embed the target in the id, so an existing match already
  // holds the requested target — focusing it is sufficient.
  const id = tabIdFor(request);
  if (state.tabs.some((tab) => tab.id === id)) {
    return { ...state, activeTabId: id };
  }

  const tab: DesktopTab = {
    id,
    kind: request.kind,
    title: titleFor(request),
    icon: TAB_KIND_ICONS[request.kind],
    ...(request.target ? { target: request.target } : {}),
  };
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

/**
 * Closes a tab and picks the next active one.
 *
 * Focus falls to the neighbor on the left (or right when closing the first
 * closable tab), matching editor conventions. The workspace tab cannot be
 * closed, so the tab list is never empty and `activeTabId` always resolves.
 */
export function closeTab(
  state: DesktopTabState,
  tabId: string,
): DesktopTabState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  if (!isClosableTabKind(state.tabs[index].kind)) return state;

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  // Closing a background tab must not steal focus from the tab in use.
  if (state.activeTabId !== tabId)
    return { tabs, activeTabId: state.activeTabId };

  // Prefer the left neighbor; `tabs[index]` is what shifted into the closed
  // slot, used when closing the leftmost closable tab.
  const fallback = tabs[index - 1] ?? tabs[index] ?? tabs[0];
  return { tabs, activeTabId: fallback?.id ?? WORKSPACE_TAB_ID };
}

export function activateTab(
  state: DesktopTabState,
  tabId: string,
): DesktopTabState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

export function setTabDirty(
  state: DesktopTabState,
  tabId: string,
  dirty: boolean,
): DesktopTabState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, dirty } : tab)),
  };
}

function findTab(
  state: DesktopTabState,
  tabId: string,
): DesktopTab | undefined {
  return state.tabs.find((tab) => tab.id === tabId);
}

export function activeTab(state: DesktopTabState): DesktopTab {
  return (
    findTab(state, state.activeTabId) ??
    state.tabs[0] ?? {
      id: WORKSPACE_TAB_ID,
      kind: 'workspace',
      title: TAB_KIND_TITLES.workspace,
      icon: TAB_KIND_ICONS.workspace,
    }
  );
}

/**
 * Maps a legacy `DesktopRoute` onto the tab kind that now owns that surface.
 * 'main' and 'progress' both live in the workspace tab: the launcher and the
 * conversation are two states of one pane, selected by whether a stream is
 * active.
 */
export function tabKindForRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): DesktopTabKind {
  switch (route) {
    case 'settings':
      return 'settings';
    case 'logs':
      return 'logs';
    default:
      return 'workspace';
  }
}
