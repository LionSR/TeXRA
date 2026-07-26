// Conversation-first desktop shell state.
//
// The desktop keeps the task conversation mounted at all times and opens
// artifacts (files, terminals, browser, settings, logs) in one optional
// workbench on the right. This mirrors the interaction model of modern agent
// clients: the transcript is the product, while implementation details remain
// available without taking over the window.
//
// This reducer is intentionally host-neutral. Electron resources are created
// and disposed by the renderer; this module only describes what is visible.

import type { TeXRAIconName } from '@shared/wa/webAwesomeIcons';

export const WORKBENCH_KINDS = [
  'editor',
  'terminal',
  'browser',
  'settings',
  'logs',
] as const;

export type WorkbenchKind = (typeof WORKBENCH_KINDS)[number];

interface WorkbenchKindMeta {
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly singleton: boolean;
}

export const WORKBENCH_KIND_META: Readonly<
  Record<WorkbenchKind, WorkbenchKindMeta>
> = {
  editor: { icon: 'file-code', label: 'Editor', singleton: false },
  terminal: { icon: 'terminal', label: 'Terminal', singleton: false },
  browser: { icon: 'globe', label: 'Browser', singleton: true },
  settings: { icon: 'gear', label: 'Settings', singleton: true },
  logs: { icon: 'file-lines', label: 'Logs', singleton: true },
};

export interface WorkbenchTab {
  readonly id: string;
  readonly kind: WorkbenchKind;
  readonly title: string;
  readonly target?: string;
  readonly dirty?: boolean;
}

export interface DesktopTaskShellState {
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
  readonly filesExpanded: boolean;
  readonly workbenchWidth: number;
  readonly workbenchTabs: readonly WorkbenchTab[];
  readonly activeWorkbenchTabId?: string;
  readonly nextTerminalSerial: number;
}

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const WORKBENCH_MIN_WIDTH = 380;
export const WORKBENCH_MAX_WIDTH = 960;

export function initialDesktopTaskShellState(): DesktopTaskShellState {
  return {
    sidebarCollapsed: false,
    sidebarWidth: 288,
    filesExpanded: true,
    workbenchWidth: 640,
    workbenchTabs: [],
    nextTerminalSerial: 1,
  };
}

export function activeWorkbenchTab(
  state: DesktopTaskShellState,
): WorkbenchTab | undefined {
  return state.workbenchTabs.find(
    (tab) => tab.id === state.activeWorkbenchTabId,
  );
}

export function workbenchTab(
  state: DesktopTaskShellState,
  tabId: string,
): WorkbenchTab | undefined {
  return state.workbenchTabs.find((tab) => tab.id === tabId);
}

function basename(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').findLast(Boolean) ?? filePath;
}

function tabId(kind: WorkbenchKind, target?: string): string {
  if (WORKBENCH_KIND_META[kind].singleton) return `workbench:${kind}`;
  return target ? `workbench:${kind}:${target}` : `workbench:${kind}`;
}

function titleFor(kind: WorkbenchKind, target?: string): string {
  return kind === 'editor' && target
    ? basename(target)
    : WORKBENCH_KIND_META[kind].label;
}

export interface OpenWorkbenchTabRequest {
  readonly kind: WorkbenchKind;
  readonly target?: string;
  readonly title?: string;
}

/**
 * Opens a workbench surface or focuses its existing tab.
 *
 * Browser/settings/logs are singletons because they represent one host-owned
 * surface. Editors are keyed by file, and terminals intentionally create a new
 * session each time.
 */
export function openWorkbenchTab(
  state: DesktopTaskShellState,
  request: OpenWorkbenchTabRequest,
): DesktopTaskShellState {
  if (request.kind === 'terminal') {
    const serial = state.nextTerminalSerial;
    const tab: WorkbenchTab = {
      id: `workbench:terminal:${serial}`,
      kind: 'terminal',
      title: request.title ?? `Terminal ${serial}`,
      ...(request.target ? { target: request.target } : {}),
    };
    return {
      ...state,
      workbenchTabs: [...state.workbenchTabs, tab],
      activeWorkbenchTabId: tab.id,
      nextTerminalSerial: serial + 1,
    };
  }

  const id = tabId(request.kind, request.target);
  const existing = workbenchTab(state, id);
  if (existing) return { ...state, activeWorkbenchTabId: id };

  const tab: WorkbenchTab = {
    id,
    kind: request.kind,
    title: request.title ?? titleFor(request.kind, request.target),
    ...(request.target ? { target: request.target } : {}),
  };

  // A generic Editor placeholder is superseded as soon as a real file opens.
  const withoutEditorPlaceholder =
    request.kind === 'editor' && request.target
      ? state.workbenchTabs.filter((entry) => entry.id !== 'workbench:editor')
      : state.workbenchTabs;

  return {
    ...state,
    workbenchTabs: [...withoutEditorPlaceholder, tab],
    activeWorkbenchTabId: tab.id,
  };
}

export function focusWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToFocus: string,
): DesktopTaskShellState {
  if (!workbenchTab(state, tabIdToFocus)) return state;
  return { ...state, activeWorkbenchTabId: tabIdToFocus };
}

export function closeWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToClose: string,
): DesktopTaskShellState {
  const index = state.workbenchTabs.findIndex((tab) => tab.id === tabIdToClose);
  if (index === -1) return state;

  const workbenchTabs = state.workbenchTabs.filter(
    (tab) => tab.id !== tabIdToClose,
  );
  if (state.activeWorkbenchTabId !== tabIdToClose) {
    return { ...state, workbenchTabs };
  }

  const fallback = workbenchTabs[index - 1] ?? workbenchTabs[index];
  return {
    ...state,
    workbenchTabs,
    activeWorkbenchTabId: fallback?.id,
  };
}

export function closeWorkbench(
  state: DesktopTaskShellState,
): DesktopTaskShellState {
  if (state.activeWorkbenchTabId == null) return state;
  return { ...state, activeWorkbenchTabId: undefined };
}

export function reopenWorkbench(
  state: DesktopTaskShellState,
): DesktopTaskShellState {
  if (state.activeWorkbenchTabId != null || state.workbenchTabs.length === 0) {
    return state;
  }
  return {
    ...state,
    activeWorkbenchTabId: state.workbenchTabs.at(-1)?.id,
  };
}

export function renameWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToRename: string,
  title: string,
): DesktopTaskShellState {
  const normalized = title.trim();
  if (!normalized) return state;
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.map((tab) =>
      tab.id === tabIdToRename ? { ...tab, title: normalized } : tab,
    ),
  };
}

export function setWorkbenchTabDirty(
  state: DesktopTaskShellState,
  tabIdToUpdate: string,
  dirty: boolean,
): DesktopTaskShellState {
  if (!workbenchTab(state, tabIdToUpdate)) return state;
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.map((tab) =>
      tab.id === tabIdToUpdate ? { ...tab, dirty } : tab,
    ),
  };
}

export function toggleSidebar(
  state: DesktopTaskShellState,
): DesktopTaskShellState {
  return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
}

export function toggleFiles(
  state: DesktopTaskShellState,
): DesktopTaskShellState {
  return { ...state, filesExpanded: !state.filesExpanded };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function setSidebarWidth(
  state: DesktopTaskShellState,
  width: number,
): DesktopTaskShellState {
  return {
    ...state,
    sidebarWidth: clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  };
}

export function setWorkbenchWidth(
  state: DesktopTaskShellState,
  width: number,
): DesktopTaskShellState {
  return {
    ...state,
    workbenchWidth: clamp(width, WORKBENCH_MIN_WIDTH, WORKBENCH_MAX_WIDTH),
  };
}

export function workbenchKindForRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): WorkbenchKind | undefined {
  if (route === 'settings') return 'settings';
  if (route === 'logs') return 'logs';
  return undefined;
}

export function workspaceInitials(workspacePath: string | undefined): string {
  if (!workspacePath) return 'TX';
  const normalized = workspacePath.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.split('/').findLast(Boolean);
  if (!name) return 'TX';
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
  return initials || 'TX';
}

export function workspaceName(workspacePath: string | undefined): string {
  if (!workspacePath) return 'No project open';
  const normalized = workspacePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').findLast(Boolean) ?? workspacePath;
}
