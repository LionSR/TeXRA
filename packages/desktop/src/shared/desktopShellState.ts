// Per-project document metadata. Dockview owns group positions, sizes and tabs.
import { z } from 'zod';

import type { TeXRAIconName } from '@shared/iconNames';
import { clamp, getBasename } from '@utils/core';
import type { SerializedDockview } from 'dockview';

export const WORKBENCH_KIND_META = {
  agent: { icon: 'comment', label: 'Agent', singleton: true },
  files: { icon: 'folder-tree', label: 'Files', singleton: true },
  editor: { icon: 'file-code', label: 'Editor', singleton: false },
  terminal: { icon: 'terminal', label: 'Terminal', singleton: false },
  browser: { icon: 'globe', label: 'Browser', singleton: true },
  review: { icon: 'plus-minus', label: 'Review', singleton: true },
  logs: { icon: 'file-lines', label: 'Logs', singleton: true },
  pdf: { icon: 'file-pdf', label: 'PDF', singleton: false },
} as const satisfies Record<
  string,
  {
    icon: TeXRAIconName;
    label: string;
    singleton: boolean;
  }
>;

export type WorkbenchKind = keyof typeof WORKBENCH_KIND_META;
const WorkbenchTabSchema = z.object({
  id: z.string(),
  kind: z.enum(Object.keys(WORKBENCH_KIND_META) as WorkbenchKind[]),
  title: z.string(),
  target: z.string().optional(),
  dirty: z.boolean().optional(),
});
export type WorkbenchTab = z.infer<typeof WorkbenchTabSchema>;

// Dockview validates the complete grid when restoring it. Keep its interchange
// format intact instead of maintaining a competing tree schema.
const DockLayoutSchema = z.custom<SerializedDockview>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'grid' in value &&
    'panels' in value,
);
export const DesktopShellStateSchema = z.object({
  projectName: z.string().default(''),
  sidebarCollapsed: z.boolean().default(false),
  sidebarWidth: z.number().default(256),
  workbenchTabs: z.array(WorkbenchTabSchema),
  activeTabId: z.string().optional(),
  dockLayout: DockLayoutSchema.nullable().default(null),
  nextTerminalSerial: z.int().positive().default(1),
});
export type DesktopShellState = z.infer<typeof DesktopShellStateSchema>;

export function initialDesktopShellState(): DesktopShellState {
  return {
    projectName: '',
    sidebarCollapsed: false,
    sidebarWidth: 256,
    workbenchTabs: [{ id: 'workbench:agent', kind: 'agent', title: 'Agent' }],
    activeTabId: 'workbench:agent',
    dockLayout: null,
    nextTerminalSerial: 1,
  };
}

export function openWorkbenchTab(
  state: DesktopShellState,
  request: { kind: WorkbenchKind; target?: string; title?: string },
): DesktopShellState {
  const { kind, target } = request;
  const meta = WORKBENCH_KIND_META[kind];
  let id = `workbench:${kind}`;
  if (kind === 'terminal') id += `:${state.nextTerminalSerial}`;
  else if (!meta.singleton && target) id += `:${target}`;
  const existing = state.workbenchTabs.find((tab) => tab.id === id);
  if (existing) return { ...state, activeTabId: id };
  let title: string = meta.label;
  if (kind === 'terminal') title = `Terminal ${state.nextTerminalSerial}`;
  else if (target && (kind === 'editor' || kind === 'pdf'))
    title = getBasename(target);
  return {
    ...state,
    activeTabId: id,
    workbenchTabs: [
      ...state.workbenchTabs,
      {
        id,
        kind,
        title: request.title ?? title,
        ...(target ? { target } : {}),
      },
    ],
    nextTerminalSerial:
      state.nextTerminalSerial + (kind === 'terminal' ? 1 : 0),
  };
}

export function closeWorkbenchTab(
  state: DesktopShellState,
  id: string,
): DesktopShellState {
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.filter((tab) => tab.id !== id),
    activeTabId: state.activeTabId === id ? undefined : state.activeTabId,
  };
}

export function renameWorkbenchTab(
  state: DesktopShellState,
  id: string,
  title: string,
): DesktopShellState {
  if (!title.trim()) return state;
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.map((tab) =>
      tab.id === id ? { ...tab, title: title.trim() } : tab,
    ),
  };
}

export function setWorkbenchTabDirty(
  state: DesktopShellState,
  id: string,
  dirty: boolean,
): DesktopShellState {
  if (!state.workbenchTabs.some((tab) => tab.id === id && tab.dirty !== dirty))
    return state;
  return {
    ...state,
    workbenchTabs: state.workbenchTabs.map((tab) =>
      tab.id === id ? { ...tab, dirty } : tab,
    ),
  };
}

export function toggleSidebar(state: DesktopShellState): DesktopShellState {
  return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
}
export function setSidebarWidth(
  state: DesktopShellState,
  width: number,
): DesktopShellState {
  const next = clamp(Math.round(width), 220, 480);
  return next === state.sidebarWidth ? state : { ...state, sidebarWidth: next };
}
