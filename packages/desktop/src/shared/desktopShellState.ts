// Per-project document metadata. Dockview owns group positions, sizes and tabs.
import { Effect, Schema } from 'effect';
import { getBasename } from '@texra-ai/harness/schemas';

import type { IconName } from '@ui/wa/iconNames';
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
    icon: IconName;
    label: string;
    singleton: boolean;
  }
>;

export type WorkbenchKind = keyof typeof WORKBENCH_KIND_META;
const WorkbenchTabSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Enum(Object.keys(WORKBENCH_KIND_META) as WorkbenchKind[]),
  title: Schema.String,
  target: Schema.optional(Schema.String),
  dirty: Schema.optional(Schema.Boolean),
  /** A `pdf` tab's build: its frame reloads when a rebuild changes it. */
  build: Schema.optional(Schema.Number),
});
export type WorkbenchTab = typeof WorkbenchTabSchema.Type;

// Dockview validates the complete grid when restoring it. Keep its interchange
// format intact instead of maintaining a competing tree schema.
const DockLayoutSchema = Schema.declare<SerializedDockview>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'grid' in value &&
    'panels' in value,
);
export const DesktopShellStateSchema = Schema.Struct({
  projectName: Schema.String.pipe(
    Schema.withDecodingDefaultType(Effect.succeed('')),
  ),
  sidebarCollapsed: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
  sidebarWidth: Schema.Number.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(256)),
  ),
  workbenchTabs: Schema.Array(WorkbenchTabSchema),
  activeTabId: Schema.optional(Schema.String),
  dockLayout: Schema.NullOr(DockLayoutSchema).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  nextTerminalSerial: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(1)),
  ),
});
export type DesktopShellState = typeof DesktopShellStateSchema.Type;

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
  request: {
    kind: WorkbenchKind;
    target?: string;
    title?: string;
    build?: number;
  },
): DesktopShellState {
  const { kind, target, build } = request;
  const meta = WORKBENCH_KIND_META[kind];
  let id = `workbench:${kind}`;
  if (kind === 'terminal') id += `:${state.nextTerminalSerial}`;
  else if (!meta.singleton && target) id += `:${target}`;
  const existing = state.workbenchTabs.find((tab) => tab.id === id);
  if (existing) {
    return {
      ...state,
      activeTabId: id,
      workbenchTabs:
        build === undefined || existing.build === build
          ? state.workbenchTabs
          : state.workbenchTabs.map((tab) =>
              tab === existing ? { ...tab, build } : tab,
            ),
    };
  }
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
        ...(build === undefined ? {} : { build }),
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
  const next = Math.max(220, Math.min(480, Math.round(width)));
  return next === state.sidebarWidth ? state : { ...state, sidebarWidth: next };
}
