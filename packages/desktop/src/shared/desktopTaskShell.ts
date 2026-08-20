// Conversation-first desktop shell state.
//
// The desktop keeps the task conversation mounted at all times and lets
// workbench tabs live beside it or below it. This mirrors modern editor shells:
// the transcript stays primary while artifacts can move to the layout that
// best fits the current task.
//
// This reducer is intentionally host-neutral. Electron resources are created
// and disposed by the renderer; this module only describes what is visible.

import type { TeXRAIconName } from '@shared/wa/iconNames';
import { clamp, getBasename } from '@utils/core';

export const WORKBENCH_KINDS = [
  'editor',
  'terminal',
  'browser',
  'review',
  'settings',
  'logs',
] as const;

export type WorkbenchKind = (typeof WORKBENCH_KINDS)[number];

export const WORKBENCH_PLACEMENTS = ['right', 'bottom'] as const;
export type WorkbenchPlacement = (typeof WORKBENCH_PLACEMENTS)[number];

interface WorkbenchKindMeta {
  readonly defaultPlacement: WorkbenchPlacement;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly singleton: boolean;
}

export const WORKBENCH_KIND_META: Readonly<
  Record<WorkbenchKind, WorkbenchKindMeta>
> = {
  editor: {
    defaultPlacement: 'right',
    icon: 'file-code',
    label: 'Editor',
    singleton: false,
  },
  terminal: {
    defaultPlacement: 'bottom',
    icon: 'terminal',
    label: 'Terminal',
    singleton: false,
  },
  browser: {
    defaultPlacement: 'right',
    icon: 'globe',
    label: 'Browser',
    singleton: true,
  },
  review: {
    defaultPlacement: 'right',
    icon: 'plus-minus',
    label: 'Review',
    singleton: true,
  },
  settings: {
    defaultPlacement: 'right',
    icon: 'gear',
    label: 'Settings',
    singleton: true,
  },
  logs: {
    defaultPlacement: 'right',
    icon: 'file-lines',
    label: 'Logs',
    singleton: true,
  },
};

export interface WorkbenchTab {
  readonly id: string;
  readonly kind: WorkbenchKind;
  readonly placement: WorkbenchPlacement;
  readonly title: string;
  readonly target?: string;
  readonly dirty?: boolean;
}

export interface DesktopTaskShellState {
  readonly activeWorkbenchTabIds: Readonly<
    Partial<Record<WorkbenchPlacement, string>>
  >;
  readonly bottomPanelHeight: number;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
  readonly filesExpanded: boolean;
  readonly projectSectionPosition: number;
  readonly summaryBarVisible: boolean;
  readonly workbenchWidth: number;
  readonly workbenchTabs: readonly WorkbenchTab[];
  readonly nextTerminalSerial: number;
}

export const BOTTOM_PANEL_MIN_HEIGHT = 180;
export const BOTTOM_PANEL_MAX_HEIGHT = 560;
export const PROJECT_SECTION_MIN_POSITION = 20;
export const PROJECT_SECTION_MAX_POSITION = 80;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const WORKBENCH_MIN_WIDTH = 380;
export const WORKBENCH_MAX_WIDTH = 960;

export function initialDesktopTaskShellState(): DesktopTaskShellState {
  return {
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
  };
}

export function activeWorkbenchTab(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement,
): WorkbenchTab | undefined {
  const activeTabId = state.activeWorkbenchTabIds[placement];
  return state.workbenchTabs.find(
    (tab) => tab.id === activeTabId && tab.placement === placement,
  );
}

export function workbenchTabsForPlacement(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement,
): readonly WorkbenchTab[] {
  return state.workbenchTabs.filter((tab) => tab.placement === placement);
}

export function workbenchTab(
  state: DesktopTaskShellState,
  tabId: string,
): WorkbenchTab | undefined {
  return state.workbenchTabs.find((tab) => tab.id === tabId);
}

function activateWorkbenchTab(
  state: DesktopTaskShellState,
  tab: WorkbenchTab,
): DesktopTaskShellState {
  const activeWorkbenchTabIds = { ...state.activeWorkbenchTabIds };
  for (const placement of WORKBENCH_PLACEMENTS) {
    if (placement === tab.placement) continue;
    const activeTab = activeWorkbenchTab(state, placement);
    if (activeTab?.kind !== tab.kind) continue;
    activeWorkbenchTabIds[placement] = workbenchTabsForPlacement(
      state,
      placement,
    ).findLast((candidate) => candidate.kind !== tab.kind)?.id;
  }
  activeWorkbenchTabIds[tab.placement] = tab.id;
  return { ...state, activeWorkbenchTabIds };
}

function tabId(kind: WorkbenchKind, target?: string): string {
  if (WORKBENCH_KIND_META[kind].singleton) return `workbench:${kind}`;
  return target ? `workbench:${kind}:${target}` : `workbench:${kind}`;
}

function titleFor(kind: WorkbenchKind, target?: string): string {
  return kind === 'editor' && target
    ? getBasename(target)
    : WORKBENCH_KIND_META[kind].label;
}

export interface OpenWorkbenchTabRequest {
  readonly kind: WorkbenchKind;
  readonly placement?: WorkbenchPlacement;
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
  const placement =
    request.placement ?? WORKBENCH_KIND_META[request.kind].defaultPlacement;
  if (request.kind === 'terminal') {
    const serial = state.nextTerminalSerial;
    const tab: WorkbenchTab = {
      id: `workbench:terminal:${serial}`,
      kind: 'terminal',
      placement,
      title: request.title ?? `Terminal ${serial}`,
      ...(request.target ? { target: request.target } : {}),
    };
    return activateWorkbenchTab(
      {
        ...state,
        workbenchTabs: [...state.workbenchTabs, tab],
        nextTerminalSerial: serial + 1,
      },
      tab,
    );
  }

  const id = tabId(request.kind, request.target);
  const existing = workbenchTab(state, id);
  if (existing) return activateWorkbenchTab(state, existing);

  const tab: WorkbenchTab = {
    id,
    kind: request.kind,
    placement,
    title: request.title ?? titleFor(request.kind, request.target),
    ...(request.target ? { target: request.target } : {}),
  };

  // A generic Editor placeholder is superseded as soon as a real file opens.
  let tabs = state.workbenchTabs;
  const activeWorkbenchTabIds = { ...state.activeWorkbenchTabIds };
  if (request.kind === 'editor' && request.target) {
    tabs = tabs.filter((entry) => entry.id !== 'workbench:editor');
    for (const placement of WORKBENCH_PLACEMENTS) {
      if (activeWorkbenchTabIds[placement] === 'workbench:editor') {
        activeWorkbenchTabIds[placement] = undefined;
      }
    }
  }

  return activateWorkbenchTab(
    {
      ...state,
      workbenchTabs: [...tabs, tab],
      activeWorkbenchTabIds,
    },
    tab,
  );
}

export function focusWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToFocus: string,
): DesktopTaskShellState {
  const tab = workbenchTab(state, tabIdToFocus);
  if (!tab) return state;
  return activateWorkbenchTab(state, tab);
}

export function closeWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToClose: string,
): DesktopTaskShellState {
  const tab = workbenchTab(state, tabIdToClose);
  if (!tab) return state;

  const workbenchTabs = state.workbenchTabs.filter(
    (entry) => entry.id !== tabIdToClose,
  );
  if (state.activeWorkbenchTabIds[tab.placement] !== tabIdToClose) {
    return { ...state, workbenchTabs };
  }

  const placementTabs = workbenchTabsForPlacement(state, tab.placement);
  const index = placementTabs.findIndex((entry) => entry.id === tabIdToClose);
  const fallback = placementTabs[index - 1] ?? placementTabs[index + 1];
  return {
    ...state,
    workbenchTabs,
    activeWorkbenchTabIds: {
      ...state.activeWorkbenchTabIds,
      [tab.placement]: fallback?.id,
    },
  };
}

export function closeWorkbench(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement,
): DesktopTaskShellState {
  if (state.activeWorkbenchTabIds[placement] == null) return state;
  return {
    ...state,
    activeWorkbenchTabIds: {
      ...state.activeWorkbenchTabIds,
      [placement]: undefined,
    },
  };
}

export function reopenWorkbench(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement,
): DesktopTaskShellState {
  if (state.activeWorkbenchTabIds[placement] != null) {
    return state;
  }
  const tab = workbenchTabsForPlacement(state, placement).at(-1);
  if (!tab) return state;
  return {
    ...state,
    activeWorkbenchTabIds: {
      ...state.activeWorkbenchTabIds,
      [placement]: tab.id,
    },
  };
}

export function toggleWorkbench(
  state: DesktopTaskShellState,
  placement: WorkbenchPlacement,
): DesktopTaskShellState {
  if (activeWorkbenchTab(state, placement)) {
    return closeWorkbench(state, placement);
  }
  return reopenWorkbench(state, placement);
}

export function moveWorkbenchTab(
  state: DesktopTaskShellState,
  tabIdToMove: string,
  placement: WorkbenchPlacement,
): DesktopTaskShellState {
  const tab = workbenchTab(state, tabIdToMove);
  if (!tab || tab.placement === placement) {
    return focusWorkbenchTab(state, tabIdToMove);
  }

  const sourceTabs = workbenchTabsForPlacement(state, tab.placement);
  const sourceIndex = sourceTabs.findIndex((entry) => entry.id === tabIdToMove);
  const sourceFallback =
    sourceTabs[sourceIndex - 1] ?? sourceTabs[sourceIndex + 1];
  const activeWorkbenchTabIds = {
    ...state.activeWorkbenchTabIds,
    [placement]: tabIdToMove,
  };
  if (state.activeWorkbenchTabIds[tab.placement] === tabIdToMove) {
    activeWorkbenchTabIds[tab.placement] = sourceFallback?.id;
  }

  const movedTab: WorkbenchTab = { ...tab, placement };
  const movedState: DesktopTaskShellState = {
    ...state,
    activeWorkbenchTabIds,
    workbenchTabs: state.workbenchTabs.map((entry) =>
      entry.id === tabIdToMove ? movedTab : entry,
    ),
  };
  return activateWorkbenchTab(movedState, movedTab);
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

export function toggleSummaryBar(
  state: DesktopTaskShellState,
): DesktopTaskShellState {
  return { ...state, summaryBarVisible: !state.summaryBarVisible };
}

// Shared by the dimension setters below: every stored size is a rounded,
// clamped pixel/percent value.
function clampedDimension(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max);
}

export function setBottomPanelHeight(
  state: DesktopTaskShellState,
  height: number,
): DesktopTaskShellState {
  return {
    ...state,
    bottomPanelHeight: clampedDimension(
      height,
      BOTTOM_PANEL_MIN_HEIGHT,
      BOTTOM_PANEL_MAX_HEIGHT,
    ),
  };
}

export function setSidebarWidth(
  state: DesktopTaskShellState,
  width: number,
): DesktopTaskShellState {
  return {
    ...state,
    sidebarWidth: clampedDimension(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  };
}

export function setProjectSectionPosition(
  state: DesktopTaskShellState,
  position: number,
): DesktopTaskShellState {
  return {
    ...state,
    projectSectionPosition: clampedDimension(
      position,
      PROJECT_SECTION_MIN_POSITION,
      PROJECT_SECTION_MAX_POSITION,
    ),
  };
}

export function setWorkbenchWidth(
  state: DesktopTaskShellState,
  width: number,
): DesktopTaskShellState {
  return {
    ...state,
    workbenchWidth: clampedDimension(
      width,
      WORKBENCH_MIN_WIDTH,
      WORKBENCH_MAX_WIDTH,
    ),
  };
}

export function workspaceInitials(workspacePath: string | undefined): string {
  if (!workspacePath) return 'TX';
  const name = getBasename(workspacePath);
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
  // A slash-only root has no basename, so show the path rather than nothing.
  return getBasename(workspacePath) || workspacePath;
}
