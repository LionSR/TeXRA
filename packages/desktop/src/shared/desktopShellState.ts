// Conversation-first desktop shell state.
//
// The desktop keeps the task conversation mounted at all times and lets
// workbench tabs live beside it or below it. This mirrors modern editor shells:
// the transcript stays primary while artifacts can move to the layout that
// best fits the current task.
//
// This reducer is intentionally host-neutral. Electron resources are created
// and disposed by the renderer; this module only describes what is visible.

import { z } from 'zod';

import type { TeXRAIconName } from '@ui/wa/iconNames';
import { clamp, getBasename } from '@utils/core';

export const WORKBENCH_PLACEMENTS = ['right', 'bottom'] as const;
export type WorkbenchPlacement = (typeof WORKBENCH_PLACEMENTS)[number];

interface WorkbenchKindMeta {
  readonly defaultPlacement: WorkbenchPlacement;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly singleton: boolean;
}

/**
 * The workbench surfaces. Sole definition of the set: `WorkbenchKind` is its
 * key type, so a surface cannot exist without its metadata (and a stray key
 * fails the exhaustive `switch` in `workbenchController`).
 */
export const WORKBENCH_KIND_META = {
  /** The project's file tree; opening a file opens an Editor tab. */
  files: {
    defaultPlacement: 'right',
    icon: 'folder-tree',
    label: 'Files',
    singleton: true,
  },
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
  logs: {
    defaultPlacement: 'right',
    icon: 'file-lines',
    label: 'Logs',
    singleton: true,
  },
  /** One compiled PDF per tab, keyed by its path (the tab's `target`). */
  pdf: {
    defaultPlacement: 'right',
    icon: 'file-pdf',
    label: 'PDF',
    singleton: false,
  },
  /** The selected stream's root subtree. While it is open the rail lists
   *  top-level runs only: the tree has one home at a time. */
  subagents: {
    defaultPlacement: 'right',
    icon: 'diagram-project',
    label: 'Subagents',
    singleton: true,
  },
} as const satisfies Record<string, WorkbenchKindMeta>;

export type WorkbenchKind = keyof typeof WORKBENCH_KIND_META;

const WorkbenchTabSchema = z.object({
  id: z.string(),
  kind: z.enum(Object.keys(WORKBENCH_KIND_META) as WorkbenchKind[]),
  placement: z.enum(WORKBENCH_PLACEMENTS),
  title: z.string(),
  target: z.string().optional(),
  dirty: z.boolean().optional(),
});

export type WorkbenchTab = z.infer<typeof WorkbenchTabSchema>;

/** Persisted per paper in Surface.workbench. */
export const DesktopShellStateSchema = z.object({
  activeWorkbenchTabIds: z.partialRecord(
    z.enum(WORKBENCH_PLACEMENTS),
    z.string().optional(),
  ),
  bottomPanelHeight: z.number(),
  sidebarCollapsed: z.boolean(),
  sidebarWidth: z.number(),
  workbenchWidth: z.number(),
  workbenchTabs: z.array(WorkbenchTabSchema),
  nextTerminalSerial: z.int().positive(),
});

export type DesktopShellState = z.infer<typeof DesktopShellStateSchema>;

const BOTTOM_PANEL_MIN_HEIGHT = 180;
const BOTTOM_PANEL_MAX_HEIGHT = 560;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const WORKBENCH_MIN_WIDTH = 380;
const WORKBENCH_MAX_WIDTH = 960;

export function initialDesktopShellState(): DesktopShellState {
  return {
    activeWorkbenchTabIds: {},
    bottomPanelHeight: 300,
    sidebarCollapsed: false,
    sidebarWidth: 288,
    workbenchWidth: 640,
    workbenchTabs: [],
    nextTerminalSerial: 1,
  };
}

export function activeWorkbenchTab(
  state: DesktopShellState,
  placement: WorkbenchPlacement,
): WorkbenchTab | undefined {
  const activeTabId = state.activeWorkbenchTabIds[placement];
  return state.workbenchTabs.find(
    (tab) => tab.id === activeTabId && tab.placement === placement,
  );
}

export function workbenchTabsForPlacement(
  state: DesktopShellState,
  placement: WorkbenchPlacement,
): readonly WorkbenchTab[] {
  return state.workbenchTabs.filter((tab) => tab.placement === placement);
}

function workbenchTab(
  state: DesktopShellState,
  tabId: string,
): WorkbenchTab | undefined {
  return state.workbenchTabs.find((tab) => tab.id === tabId);
}

function activateWorkbenchTab(
  state: DesktopShellState,
  tab: WorkbenchTab,
): DesktopShellState {
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
  if (WORKBENCH_KIND_META[kind].singleton || !target)
    return `workbench:${kind}`;
  return `workbench:${kind}:${target}`;
}

function titleFor(kind: WorkbenchKind, target?: string): string {
  return (kind === 'editor' || kind === 'pdf') && target
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
 * Browser/logs are singletons because they represent one host-owned
 * surface. Editors are keyed by file, and terminals intentionally create a new
 * session each time.
 */
export function openWorkbenchTab(
  state: DesktopShellState,
  request: OpenWorkbenchTabRequest,
): DesktopShellState {
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
  state: DesktopShellState,
  tabIdToFocus: string,
): DesktopShellState {
  const tab = workbenchTab(state, tabIdToFocus);
  if (!tab) return state;
  return activateWorkbenchTab(state, tab);
}

export function closeWorkbenchTab(
  state: DesktopShellState,
  tabIdToClose: string,
): DesktopShellState {
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
  state: DesktopShellState,
  placement: WorkbenchPlacement,
): DesktopShellState {
  if (state.activeWorkbenchTabIds[placement] == null) return state;
  return {
    ...state,
    activeWorkbenchTabIds: {
      ...state.activeWorkbenchTabIds,
      [placement]: undefined,
    },
  };
}

function reopenWorkbench(
  state: DesktopShellState,
  placement: WorkbenchPlacement,
): DesktopShellState {
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
  state: DesktopShellState,
  placement: WorkbenchPlacement,
): DesktopShellState {
  if (activeWorkbenchTab(state, placement)) {
    return closeWorkbench(state, placement);
  }
  return reopenWorkbench(state, placement);
}

export function moveWorkbenchTab(
  state: DesktopShellState,
  tabIdToMove: string,
  placement: WorkbenchPlacement,
): DesktopShellState {
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
  const movedState: DesktopShellState = {
    ...state,
    activeWorkbenchTabIds,
    workbenchTabs: state.workbenchTabs.map((entry) =>
      entry.id === tabIdToMove ? movedTab : entry,
    ),
  };
  return activateWorkbenchTab(movedState, movedTab);
}

export function renameWorkbenchTab(
  state: DesktopShellState,
  tabIdToRename: string,
  title: string,
): DesktopShellState {
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
  state: DesktopShellState,
  tabIdToUpdate: string,
  dirty: boolean,
): DesktopShellState {
  if (!workbenchTab(state, tabIdToUpdate)) return state;
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.map((tab) =>
      tab.id === tabIdToUpdate ? { ...tab, dirty } : tab,
    ),
  };
}

export function toggleSidebar(state: DesktopShellState): DesktopShellState {
  return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
}

// Shared by the dimension setters below: every stored size is a rounded,
// clamped pixel/percent value.
function clampedDimension(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max);
}

export function setBottomPanelHeight(
  state: DesktopShellState,
  height: number,
): DesktopShellState {
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
  state: DesktopShellState,
  width: number,
): DesktopShellState {
  return {
    ...state,
    sidebarWidth: clampedDimension(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  };
}

export function setWorkbenchWidth(
  state: DesktopShellState,
  width: number,
): DesktopShellState {
  return {
    ...state,
    workbenchWidth: clampedDimension(
      width,
      WORKBENCH_MIN_WIDTH,
      WORKBENCH_MAX_WIDTH,
    ),
  };
}
