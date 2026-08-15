import type {
  AgentCategory,
  GettingStartedAction,
  SettingsTab,
  StreamTabId,
} from '@shared/schemas';
import { SETTINGS_TAB } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  toElectronAccelerator,
  toPlatformAccelerator,
} from '@shared/commands/accelerators';
import { commandCatalogById, type CommandId } from '@shared/commands/catalog';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopWorkbenchKind,
} from './desktopShellMessages.js';

export const DESKTOP_LOCAL_COMMANDS = {
  SHOW_LOGS: 'texra.desktop.showLogs',
  TOGGLE_BOTTOM_BAR: 'texra.desktop.toggleBottomBar',
  TOGGLE_SIDE_PANEL: 'texra.desktop.toggleSidePanel',
  TOGGLE_SUMMARY_BAR: 'texra.desktop.toggleSummaryBar',
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
    DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR,
    DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
    DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
    'texra.mainView.reset',
  ],
  [
    'texra.showMemory',
    'texra.showAgentHistory',
    'texra.showModels',
    'texra.showAgents',
    'texra.showTools',
    'texra.showMultiAgent',
    'texra.showGitSettings',
  ],
] as const satisfies readonly (readonly (
  CommandId | DesktopLocalCommandId
)[])[];

export const DESKTOP_FILE_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
] as const satisfies readonly DesktopLocalCommandId[];

export const DESKTOP_HELP_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

type DesktopMenuCommandId = (typeof DESKTOP_MENU_GROUPS)[number][number];
type DesktopFileCommandId = (typeof DESKTOP_FILE_COMMANDS)[number];
type DesktopHelpCommandId = (typeof DESKTOP_HELP_COMMANDS)[number];
export type DesktopCommandId =
  DesktopFileCommandId | DesktopMenuCommandId | DesktopHelpCommandId;

export const DESKTOP_COMMAND_IDS: readonly DesktopCommandId[] = [
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
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR]: 'list-ul',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR]: 'window-maximize',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL]: 'picture-in-picture',
  'texra.mainView.reset': 'file-circle-plus',
  'texra.showMemory': 'database',
  'texra.showAgentHistory': 'clock-rotate-left',
  'texra.showModels': 'server',
  'texra.showAgents': 'robot',
  'texra.showTools': 'screwdriver-wrench',
  'texra.showMultiAgent': 'diagram-project',
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
 * nothing. `showStream` is the one genuine option: it is reachable only from
 * the renderer's palette (stream rows), never from the native menu, so the
 * main-process action set does not implement it.
 */
export interface DesktopCommandActions {
  showLauncher(): void;
  openWorkbench(kind: DesktopWorkbenchKind): void;
  showSettings(tabIndex?: SettingsTab, agentSubTab?: AgentCategory): void;
  showStream?(streamId: StreamTabId): void;
  openDesktopDocs(): void;
  openLogFolder(): void;
  openWorkspaceFolder(): void;
  saveFile(): void;
  showFirstRunWalkthrough(): void;
  resetMainView(): void;
  toggleBottomBar(): void;
  toggleSidePanel(): void;
  toggleSummaryBar(): void;
}

export interface DesktopSettingsTabMessage {
  command: typeof SETTINGS_VIEW_COMMANDS.SET_TAB;
  tabIndex: SettingsTab;
  agentSubTab?: AgentCategory;
}

export interface DesktopMainViewResetMessage {
  command: typeof MAIN_VIEW_COMMANDS.STATE_RESTORE;
  isResetOperation: true;
}

const DESKTOP_LOCAL_COMMAND_ENTRIES = new Map<
  DesktopLocalCommandId,
  Omit<DesktopCommandMenuEntry, 'icon'>
>([
  [
    DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
    {
      id: DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
      label: 'Save',
      category: 'File',
      accelerator: 'CommandOrControl+S',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
      label: 'Desktop Documentation',
      category: 'Help',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
    {
      id: DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
      label: 'Show Logs',
      category: 'TeXRA',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
    {
      id: DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
      label: 'Toggle Bottom Bar',
      category: 'View',
      accelerator: 'CommandOrControl+J',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
    {
      id: DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
      label: 'Toggle Side Panel',
      category: 'View',
      accelerator: 'CommandOrControl+Alt+B',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR,
    {
      id: DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR,
      label: 'Toggle Summary Bar',
      category: 'View',
      accelerator: 'CommandOrControl+Alt+S',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
      label: 'Open Folder',
      category: 'File',
      accelerator: 'CommandOrControl+O',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
      label: 'Open Logs Folder',
      category: 'TeXRA',
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
    {
      id: DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
      label: 'Show Startup Team Chooser',
      category: 'Help',
    },
  ],
]);

export function getDesktopCommandMenuEntries(
  platform: NodeJS.Platform = process.platform,
): DesktopCommandMenuEntry[] {
  return DESKTOP_COMMAND_IDS.map((id) => {
    if (isDesktopLocalCommandId(id)) {
      const localEntry = DESKTOP_LOCAL_COMMAND_ENTRIES.get(id);
      if (!localEntry) throw new Error(`Missing desktop command entry: ${id}`);
      return {
        ...localEntry,
        icon: DESKTOP_COMMAND_ICONS[id],
        accelerator: toPlatformAccelerator(localEntry.accelerator, platform),
      };
    }

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
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR]: action((a) =>
    a.toggleSummaryBar(),
  ),
  'texra.showDashboard': action((a) => a.showSettings()),
  'texra.mainView.reset': action((a) => a.resetMainView()),
  'texra.showMemory': action((a) => a.showSettings(SETTINGS_TAB.MEMORY)),
  'texra.showAgentHistory': action((a) => a.showSettings(SETTINGS_TAB.HISTORY)),
  'texra.showModels': action((a) => a.showSettings(SETTINGS_TAB.MODELS)),
  'texra.showAgents': action((a) => a.showSettings(SETTINGS_TAB.AGENTS)),
  'texra.showTools': action((a) => a.showSettings(SETTINGS_TAB.TOOLS)),
  'texra.showMultiAgent': action((a) =>
    a.showSettings(SETTINGS_TAB.MULTI_AGENT),
  ),
  'texra.showGitSettings': action((a) => a.showSettings(SETTINGS_TAB.GIT)),
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

function isDesktopLocalCommandId(id: string): id is DesktopLocalCommandId {
  return (Object.values(DESKTOP_LOCAL_COMMANDS) as readonly string[]).includes(
    id,
  );
}

export function buildDesktopSettingsTabMessage(
  tabIndex: SettingsTab,
  agentSubTab?: AgentCategory,
): DesktopSettingsTabMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.SET_TAB,
    tabIndex,
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
  tabIndex?: SettingsTab,
  agentSubTab?: AgentCategory,
): void {
  postToRenderer({
    command: DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH,
    kind: 'settings',
  });
  if (tabIndex == null) return;
  postToRenderer(buildDesktopSettingsTabMessage(tabIndex, agentSubTab));
}

export function buildDesktopMainViewResetMessage(): DesktopMainViewResetMessage {
  return {
    command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
    isResetOperation: true,
  };
}
