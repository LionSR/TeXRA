import type { AgentCategory, GettingStartedAction } from '@shared/schemas';
import type { SettingsTarget } from '@shared/settingsView/settingsViewMessages';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  toElectronAccelerator,
  type DesktopPlatform,
} from '@shared/commands/accelerators';
import {
  commandCatalogById,
  settingsTabByCommand,
  type CommandId,
  type SettingsTabCommandId,
} from '@shared/commands/catalog';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { DESKTOP_LOG_COMMANDS } from './desktopLogMessages.js';
import { DESKTOP_ONBOARDING_COMMANDS } from './desktopOnboardingMessages.js';
import { DESKTOP_PROJECT_COMMANDS } from './desktopProjectMessages.js';
import { DESKTOP_PROMPT_COMMANDS } from './desktopPromptMessages.js';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopWorkbenchKind,
} from './desktopShellMessages.js';
import { DESKTOP_WORKSPACE_COMMANDS } from './desktopWorkspaceMessages.js';

export const DESKTOP_LOCAL_COMMANDS = {
  SHOW_LOGS: 'texra.desktop.showLogs',
  TOGGLE_BOTTOM_BAR: 'texra.desktop.toggleBottomBar',
  TOGGLE_SIDE_PANEL: 'texra.desktop.toggleSidePanel',
  OPEN_LOG_FOLDER: 'texra.desktop.openLogFolder',
  OPEN_WORKSPACE_FOLDER: 'texra.desktop.openWorkspaceFolder',
  SAVE_FILE: 'texra.desktop.saveFile',
  SHOW_FIRST_RUN_WALKTHROUGH: 'texra.desktop.showFirstRunWalkthrough',
  OPEN_DESKTOP_DOCS: 'texra.desktop.openDesktopDocs',
} as const;

export const DESKTOP_DOCS_URL = 'https://texra.ai/guide/desktop';

type VsCodeOnlyGettingStartedAction = Exclude<
  GettingStartedAction,
  'openWalkthrough'
>;

const VS_CODE_ONLY_GETTING_STARTED_LABELS = {
  runSetup: 'Run setup assistant',
  createSampleProject: 'Create sample project',
  cloneOverleaf: 'Import from Overleaf',
  downloadArxiv: 'Import from arXiv',
} as const satisfies Record<VsCodeOnlyGettingStartedAction, string>;

/**
 * Sole owner of the desktop reply for a getting-started action only the VS Code
 * extension can carry out. Both entry points (the main-view banner and the
 * progress empty state) route here so the two cannot drift in wording.
 */
export function vsCodeOnlyGettingStartedMessage(
  action: VsCodeOnlyGettingStartedAction,
): string {
  return `"${VS_CODE_ONLY_GETTING_STARTED_LABELS[action]}" requires the VS Code extension.`;
}

type DesktopLocalCommandId =
  (typeof DESKTOP_LOCAL_COMMANDS)[keyof typeof DESKTOP_LOCAL_COMMANDS];

export const DESKTOP_MENU_GROUPS = [
  [
    'texra.showMainView',
    DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
    DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    'texra.showDashboard',
    DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
    DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
  ],
  // One row per settings page that has a command, in nav order. Teams are a
  // section of Agents, so texra.showMultiAgent gets no row of its own.
  [
    'texra.showModels',
    'texra.showAgents',
    'texra.showTools',
    'texra.showMemory',
    'texra.showGitSettings',
  ],
] as const satisfies readonly (readonly CommandId[])[];

export const DESKTOP_FILE_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
] as const satisfies readonly DesktopLocalCommandId[];

/**
 * The desktop-local commands the renderer is allowed to post over IPC. Narrower
 * than `DESKTOP_LOCAL_COMMANDS` on purpose: the main-process actions for
 * `SAVE_FILE` and the two `TOGGLE_*` commands post *back* to the renderer, so
 * accepting them here would let a renderer message bounce.
 */
export const DESKTOP_SHELL_IPC_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

export const DESKTOP_HELP_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

/**
 * The main process's inbound surfaces, one per renderer→main command
 * namespace. A message's `command` names the surface that owns it, so the
 * main process reads the route once and hands the message to that one
 * handler instead of offering it to every handler in turn.
 */
export type DesktopInboundRoute =
  | 'logs'
  | 'onboarding'
  | 'projects'
  | 'prompt'
  | 'settings'
  | 'shell'
  | 'workspace';

/**
 * Whole namespaces, not hand-listed inbound halves: the request/response
 * pairs of one surface share a prefix, and the handler that owns the surface
 * is also the one that would drop a reply the renderer posted back by
 * mistake. The settings view keeps its own camelCase namespace
 * (`SETTINGS_VIEW_COMMANDS`), which both hosts share. `shell` is the one
 * carve-out: its ids are two disjoint lists, so only the inbound
 * `DESKTOP_SHELL_IPC_COMMANDS` are routed and a stray outbound
 * `DESKTOP_SHELL_COMMANDS` reply is dropped for having no route at all.
 */
const DESKTOP_INBOUND_ROUTE_COMMANDS: Record<
  DesktopInboundRoute,
  readonly string[]
> = {
  logs: Object.values(DESKTOP_LOG_COMMANDS),
  onboarding: Object.values(DESKTOP_ONBOARDING_COMMANDS),
  projects: Object.values(DESKTOP_PROJECT_COMMANDS),
  prompt: Object.values(DESKTOP_PROMPT_COMMANDS),
  settings: Object.values(SETTINGS_VIEW_COMMANDS),
  shell: DESKTOP_SHELL_IPC_COMMANDS,
  workspace: Object.values(DESKTOP_WORKSPACE_COMMANDS),
};

const DESKTOP_ROUTE_BY_COMMAND = new Map<string, DesktopInboundRoute>(
  (
    Object.entries(DESKTOP_INBOUND_ROUTE_COMMANDS) as [
      DesktopInboundRoute,
      readonly string[],
    ][]
  ).flatMap(([route, commands]) =>
    commands.map((command) => [command, route] as const),
  ),
);

/** The surface a renderer command belongs to, or undefined for none. */
export function desktopInboundRoute(
  command: string,
): DesktopInboundRoute | undefined {
  return DESKTOP_ROUTE_BY_COMMAND.get(command);
}

type DesktopMenuCommandId = (typeof DESKTOP_MENU_GROUPS)[number][number];
type DesktopFileCommandId = (typeof DESKTOP_FILE_COMMANDS)[number];
type DesktopHelpCommandId = (typeof DESKTOP_HELP_COMMANDS)[number];
export type DesktopCommandId =
  DesktopFileCommandId | DesktopMenuCommandId | DesktopHelpCommandId;

const DESKTOP_COMMAND_IDS: readonly DesktopCommandId[] = [
  ...DESKTOP_FILE_COMMANDS,
  ...DESKTOP_MENU_GROUPS.flat(),
  ...DESKTOP_HELP_COMMANDS,
];

const DESKTOP_COMMAND_ICONS = {
  [DESKTOP_LOCAL_COMMANDS.SAVE_FILE]: 'floppy-disk',
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: 'folder-open',
  'texra.showMainView': 'pencil',
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: 'file-lines',
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: 'folder',
  'texra.showDashboard': 'gear',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR]: 'window-maximize',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL]: 'picture-in-picture',
  'texra.showMemory': 'database',
  'texra.showModels': 'server',
  'texra.showAgents': 'robot',
  'texra.showTools': 'screwdriver-wrench',
  'texra.showGitSettings': 'code-branch',
  [DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH]: 'users',
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: 'book',
} as const satisfies Record<DesktopCommandId, TeXRAIconName>;

export interface DesktopCommandMenuEntry {
  id: DesktopCommandId;
  label: string;
  category: string;
  icon: TeXRAIconName;
  accelerator?: string;
}

/**
 * Capabilities the desktop registry handlers need from the host. Mirrors
 * `ExtensionCommandActions` in shape — both register parallel handler maps
 * over the same `CommandId` union with their host-specific actions, and both
 * require every action a registered handler can reach, so a miswired host
 * fails to compile instead of producing a menu item that silently does
 * nothing.
 */
export interface DesktopCommandActions {
  showLauncher(): void;
  openWorkbench(kind: DesktopWorkbenchKind): void;
  showSettings(tab?: SettingsTarget, agentSubTab?: AgentCategory): void;
  openDesktopDocs(): void;
  openLogFolder(): void;
  openWorkspaceFolder(): void;
  saveFile(): void;
  showFirstRunWalkthrough(): void;
  toggleBottomBar(): void;
  toggleSidePanel(): void;
}

interface DesktopSettingsTabMessage {
  command: typeof SETTINGS_VIEW_COMMANDS.SET_TAB;
  tab: SettingsTarget;
  agentSubTab?: AgentCategory;
}

export function getDesktopCommandMenuEntries(
  platform: DesktopPlatform,
): DesktopCommandMenuEntry[] {
  return DESKTOP_COMMAND_IDS.map((id) => {
    const entry = commandCatalogById.get(id);
    if (!entry) throw new Error(`Missing command catalog entry: ${id}`);

    const accelerator =
      entry.keybinding == null
        ? undefined
        : toElectronAccelerator(entry.keybinding, platform);
    return {
      id,
      label: entry.shortTitle ?? entry.title,
      category: entry.category,
      icon: DESKTOP_COMMAND_ICONS[id],
      ...(accelerator && { accelerator }),
    };
  });
}

type DesktopCommandHandler = CommandHandler<DesktopCommandActions>;

// Run an action and report the command as handled.
function action(
  run: (actions: DesktopCommandActions) => void,
): DesktopCommandHandler {
  return (actions) => {
    run(actions);
    return true;
  };
}

const DESKTOP_COMMAND_HANDLERS = {
  'texra.showMainView': action((a) => a.showLauncher()),
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: action((a) => a.openWorkbench('logs')),
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR]: action((a) =>
    a.toggleBottomBar(),
  ),
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL]: action((a) =>
    a.toggleSidePanel(),
  ),
  'texra.showDashboard': action((a) => a.showSettings()),
  // `texra.show*` rows derived from the catalog's `settingsTab` field
  // (`settingsTabByCommand`) — same source the extension handler map uses.
  ...(Object.fromEntries(
    (
      Object.entries(settingsTabByCommand) as [
        SettingsTabCommandId,
        SettingsTarget,
      ][]
    ).map(([id, tab]) => [id, action((a) => a.showSettings(tab))]),
  ) as Record<SettingsTabCommandId, DesktopCommandHandler>),
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: action((a) => a.openLogFolder()),
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: action((a) =>
    a.openWorkspaceFolder(),
  ),
  [DESKTOP_LOCAL_COMMANDS.SAVE_FILE]: action((a) => a.saveFile()),
  [DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH]: action((a) =>
    a.showFirstRunWalkthrough(),
  ),
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: action((a) =>
    a.openDesktopDocs(),
  ),
} as const satisfies Record<DesktopCommandId, DesktopCommandHandler>;

export function dispatchDesktopCommand(
  id: DesktopCommandId,
  actions: DesktopCommandActions,
): boolean | Promise<boolean> {
  return dispatchCommandFromRegistry(
    id,
    DESKTOP_COMMAND_HANDLERS,
    actions,
    (failure) => {
      if (failure.kind === 'invalidArguments') {
        console.error(
          `[desktop] dispatch: invalid arguments for ${failure.id}: ${failure.error.message}`,
        );
        return;
      }
      // Every desktop command id has a handler, so an unhandled id means a
      // stale IPC payload or schema drift. Surface it at error level so the
      // bug shows up in support logs without crashing the click handler.
      console.error(`[desktop] dispatch: unhandled command ${failure.id}`);
    },
  );
}

export function buildDesktopSettingsTabMessage(
  tab: SettingsTarget,
  agentSubTab?: AgentCategory,
): DesktopSettingsTabMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.SET_TAB,
    tab,
    ...(agentSubTab && { agentSubTab }),
  };
}

/**
 * Opens the Settings workbench before selecting an optional settings tab.
 * Main-process navigation has two consumers, so this helper keeps their
 * message ordering identical.
 */
export function postDesktopSettingsView(
  postToRenderer: (message: unknown) => void,
  tab?: SettingsTarget,
  agentSubTab?: AgentCategory,
): void {
  postToRenderer({
    command: DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH,
    kind: 'settings',
  });
  if (tab == null) return;
  postToRenderer(buildDesktopSettingsTabMessage(tab, agentSubTab));
}
