import {
  commandCatalogById,
  type CommandId,
  type CommandKeybinding,
} from '@commands/catalog';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type { StreamTabId } from '@shared/schemas';
import { type AgentCategory } from '@shared/schemas/agent';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopRoute } from './desktopShellMessages.js';

export { SETTINGS_TAB };

export const DESKTOP_LOCAL_COMMANDS = {
  SHOW_LOGS: 'texra.desktop.showLogs',
  OPEN_LOG_FOLDER: 'texra.desktop.openLogFolder',
  OPEN_WORKSPACE_FOLDER: 'texra.desktop.openWorkspaceFolder',
  OPEN_WORKSPACE_IN_NEW_WINDOW: 'texra.desktop.openWorkspaceInNewWindow',
  SHOW_FIRST_RUN_WALKTHROUGH: 'texra.desktop.showFirstRunWalkthrough',
  OPEN_DESKTOP_DOCS: 'texra.desktop.openDesktopDocs',
} as const;

export const DESKTOP_DOCS_URL = 'https://texra.ai/guide/desktop';

type DesktopLocalCommandId =
  (typeof DESKTOP_LOCAL_COMMANDS)[keyof typeof DESKTOP_LOCAL_COMMANDS];

const DESKTOP_MENU_GROUPS = [
  [
    'texra.showMainView',
    'texra.showProgressView',
    DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
    DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    'texra.openSettings',
    'texra.mainView.reset',
  ],
  [
    'texra.execute',
    'texra.runSetupAssistant',
    'texra.showImportOptions',
    'texra.showMemory',
    'texra.showAgentHistory',
    'texra.showModels',
    'texra.showAgents',
    'texra.showTools',
    'texra.showMultiAgent',
    'texra.openGettingStarted',
    'texra.cleanOutput',
    'texra.cleanBuild',
  ],
] as const satisfies readonly (readonly (
  | CommandId
  | DesktopLocalCommandId
)[])[];

const DESKTOP_FILE_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW,
] as const satisfies readonly DesktopLocalCommandId[];

const DESKTOP_HELP_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

type DesktopMenuCommandId = (typeof DESKTOP_MENU_GROUPS)[number][number];
type DesktopFileCommandId = (typeof DESKTOP_FILE_COMMANDS)[number];
type DesktopHelpCommandId = (typeof DESKTOP_HELP_COMMANDS)[number];
export type DesktopCommandId =
  | DesktopFileCommandId
  | DesktopMenuCommandId
  | DesktopHelpCommandId;

export const DESKTOP_COMMAND_IDS: readonly DesktopCommandId[] = [
  ...DESKTOP_FILE_COMMANDS,
  ...DESKTOP_MENU_GROUPS.flat(),
  ...DESKTOP_HELP_COMMANDS,
];

export interface DesktopCommandMenuEntry {
  id: DesktopCommandId;
  label: string;
  category: string;
  accelerator?: string;
  enabled: boolean;
  unavailableReason?: string;
}

export interface DesktopCommandActions {
  showRoute(route: DesktopRoute): void;
  showSettings(tabIndex?: SettingsTab, agentSubTab?: AgentCategory): void;
  showStream?(streamId: StreamTabId): void;
  openDesktopDocs?(): void;
  openLogFolder?(): void;
  openWorkspaceFolder?(): void;
  openWorkspaceInNewWindow?(): void;
  showFirstRunWalkthrough?(): void;
  resetMainView?(): void;
}

export interface DesktopSettingsTabMessage {
  command: typeof SETTINGS_VIEW_COMMANDS.SET_TAB;
  tabIndex: SettingsTab;
  agentSubTab?: AgentCategory;
}

export interface DesktopMainViewResetMessage {
  command: typeof MAIN_VIEW_COMMANDS.STATE_RESTORE;
  state: Record<string, never>;
  isResetOperation: true;
}

const DESKTOP_LOCAL_COMMAND_ENTRIES = new Map<
  DesktopLocalCommandId,
  DesktopCommandMenuEntry
>([
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
      label: 'Desktop Documentation',
      category: 'Help',
      enabled: true,
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
    {
      id: DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
      label: 'Show Logs',
      category: 'TeXRA',
      enabled: true,
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
      label: 'Open Folder',
      category: 'File',
      accelerator: 'CommandOrControl+O',
      enabled: true,
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW,
      label: 'New Window',
      category: 'File',
      accelerator: 'CommandOrControl+Shift+N',
      enabled: true,
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
      label: 'Open Logs Folder',
      category: 'TeXRA',
      enabled: true,
    },
  ],
  [
    DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
    {
      id: DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
      label: 'Show First-Run Walkthrough',
      category: 'Help',
      enabled: true,
    },
  ],
]);

const DESKTOP_UNAVAILABLE_COMMAND_ENTRIES = [
  [
    'texra.execute',
    'Use the Launcher execute button after choosing an agent and files.',
  ],
  [
    'texra.runSetupAssistant',
    'The setup assistant agent is still VS Code-only.',
  ],
  ['texra.showImportOptions', 'Project import choices are still VS Code-only.'],
  [
    'texra.openGettingStarted',
    'The VS Code walkthrough is not available in desktop.',
  ],
  [
    'texra.cleanOutput',
    'Workspace cleanup commands are not wired in desktop yet.',
  ],
  [
    'texra.cleanBuild',
    'Workspace cleanup commands are not wired in desktop yet.',
  ],
] as const satisfies readonly (readonly [CommandId, string])[];

type DesktopUnavailableCommandId =
  (typeof DESKTOP_UNAVAILABLE_COMMAND_ENTRIES)[number][0];

type DesktopAvailableCommandId = Exclude<
  DesktopCommandId,
  DesktopUnavailableCommandId
>;

const DESKTOP_UNAVAILABLE_COMMANDS = new Map<CommandId, string>(
  DESKTOP_UNAVAILABLE_COMMAND_ENTRIES,
);

export function getDesktopCommandMenuEntries(
  ids: readonly DesktopCommandId[] = DESKTOP_COMMAND_IDS,
  platform: NodeJS.Platform = process.platform,
): DesktopCommandMenuEntry[] {
  return ids.map((id) => {
    if (isDesktopLocalCommandId(id)) {
      return resolveLocalCommandEntry(id, platform);
    }

    const entry = commandCatalogById.get(id);
    if (!entry) throw new Error(`Missing command catalog entry: ${id}`);
    const unavailableReason = DESKTOP_UNAVAILABLE_COMMANDS.get(id);

    const accelerator =
      entry.keybinding == null
        ? undefined
        : toElectronAccelerator(entry.keybinding, platform);
    return {
      id,
      label: entry.shortTitle ?? entry.title,
      category: entry.category,
      ...(accelerator && { accelerator }),
      enabled: unavailableReason == null,
      ...(unavailableReason && { unavailableReason }),
    };
  });
}

function resolveLocalCommandEntry(
  id: DesktopLocalCommandId,
  platform: NodeJS.Platform,
): DesktopCommandMenuEntry {
  const entry = DESKTOP_LOCAL_COMMAND_ENTRIES.get(id);
  if (!entry) throw new Error(`Missing desktop command entry: ${id}`);
  return {
    ...entry,
    accelerator: toPlatformAccelerator(entry.accelerator, platform),
  };
}

export function toElectronAccelerator(
  keybinding: CommandKeybinding,
  platform: NodeJS.Platform = process.platform,
): string {
  const key =
    platform === 'darwin' && keybinding.mac ? keybinding.mac : keybinding.key;
  return key.split('+').map(toElectronAcceleratorPart).join('+');
}

const DESKTOP_COMMAND_HANDLERS = {
  'texra.showMainView': (actions) => {
    actions.showRoute('main');
    return true;
  },
  'texra.showProgressView': (actions) => {
    actions.showRoute('progress');
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: (actions) => {
    actions.showRoute('logs');
    return true;
  },
  'texra.openSettings': (actions) => {
    actions.showSettings();
    return true;
  },
  'texra.mainView.reset': (actions) => {
    if (!actions.resetMainView) return false;
    actions.resetMainView();
    return true;
  },
  'texra.showMemory': (actions) => {
    actions.showSettings(SETTINGS_TAB.MEMORY);
    return true;
  },
  'texra.showAgentHistory': (actions) => {
    actions.showSettings(SETTINGS_TAB.HISTORY);
    return true;
  },
  'texra.showModels': (actions) => {
    actions.showSettings(SETTINGS_TAB.MODELS);
    return true;
  },
  'texra.showAgents': (actions) => {
    actions.showSettings(SETTINGS_TAB.AGENTS);
    return true;
  },
  'texra.showTools': (actions) => {
    actions.showSettings(SETTINGS_TAB.TOOLS);
    return true;
  },
  'texra.showMultiAgent': (actions) => {
    actions.showSettings(SETTINGS_TAB.MULTI_AGENT);
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: (actions) => {
    if (!actions.openLogFolder) return false;
    actions.openLogFolder();
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: (actions) => {
    if (!actions.openWorkspaceFolder) return false;
    actions.openWorkspaceFolder();
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW]: (actions) => {
    if (!actions.openWorkspaceInNewWindow) return false;
    actions.openWorkspaceInNewWindow();
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH]: (actions) => {
    if (!actions.showFirstRunWalkthrough) return false;
    actions.showFirstRunWalkthrough();
    return true;
  },
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: (actions) => {
    if (!actions.openDesktopDocs) return false;
    actions.openDesktopDocs();
    return true;
  },
} as const satisfies Record<
  DesktopAvailableCommandId,
  CommandHandler<DesktopCommandActions>
>;

export function dispatchDesktopCommand(
  id: DesktopCommandId,
  actions: DesktopCommandActions,
): boolean | Promise<boolean> {
  return dispatchCommandFromRegistry(
    id,
    DESKTOP_COMMAND_HANDLERS,
    actions,
    (unhandledId) => {
      // The unavailable-command IDs (texra.execute etc.) are valid menu
      // entries with no handler by design — silent fallthrough is correct.
      // Only IDs absent from both the registry AND the unavailable list
      // indicate a stale IPC payload or schema drift; surface those at
      // error level so the bug shows up in support logs without crashing
      // the click handler / IPC dispatcher.
      if (DESKTOP_UNAVAILABLE_COMMANDS.has(unhandledId as CommandId)) return;
      console.error(`[desktop] dispatch: unhandled command ${unhandledId}`);
    },
  );
}

function isDesktopLocalCommandId(id: string): id is DesktopLocalCommandId {
  return (Object.values(DESKTOP_LOCAL_COMMANDS) as readonly string[]).includes(
    id,
  );
}

function toPlatformAccelerator(
  accelerator: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!accelerator) return undefined;
  if (platform !== 'darwin') return accelerator;
  return accelerator.replaceAll('CommandOrControl', 'Command');
}

export function formatDesktopAccelerator(
  accelerator: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!accelerator) return undefined;
  const isMac = platform === 'darwin';
  const parts = accelerator
    .replaceAll('CommandOrControl', isMac ? 'Command' : 'Control')
    .split('+')
    .map((part) => toDisplayAcceleratorPart(part, platform));
  return parts.join(isMac ? '' : '+');
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

export function buildDesktopMainViewResetMessage(): DesktopMainViewResetMessage {
  return {
    command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
    state: {},
    isResetOperation: true,
  };
}

export function buildDesktopMenuTemplate(
  actions: DesktopCommandActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const entriesById = new Map(
    getDesktopCommandMenuEntries(DESKTOP_COMMAND_IDS, platform).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const commandItem = (id: DesktopCommandId): MenuItemConstructorOptions => {
    const entry = entriesById.get(id);
    if (!entry) throw new Error(`Missing desktop menu entry: ${id}`);
    return {
      label: entry.label,
      ...(entry.accelerator && { accelerator: entry.accelerator }),
      ...(entry.unavailableReason && { toolTip: entry.unavailableReason }),
      enabled: entry.enabled,
      click: () => {
        if (!entry.enabled) return;
        dispatchDesktopCommand(id, actions);
      },
    };
  };
  const customMenu: MenuItemConstructorOptions = {
    label: 'TeXRA',
    submenu: [
      ...DESKTOP_MENU_GROUPS[0].map(commandItem),
      { type: 'separator' },
      ...DESKTOP_MENU_GROUPS[1].map(commandItem),
    ],
  };
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      ...DESKTOP_FILE_COMMANDS.map(commandItem),
      { type: 'separator' },
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  return [
    ...(platform === 'darwin'
      ? ([{ role: 'appMenu' }, fileMenu] satisfies MenuItemConstructorOptions[])
      : ([fileMenu] satisfies MenuItemConstructorOptions[])),
    customMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: DESKTOP_HELP_COMMANDS.map(commandItem),
    },
  ];
}

function toElectronAcceleratorPart(part: string): string {
  const normalized = part.trim().toLowerCase();
  switch (normalized) {
    case 'cmd':
      return 'Command';
    case 'ctrl':
      return 'Control';
    case 'option':
      return 'Option';
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
    case 'enter':
      return 'Enter';
    case 'escape':
      return 'Escape';
    case 'space':
      return 'Space';
    case 'tab':
      return 'Tab';
    default:
      if (/^f\d{1,2}$/.test(normalized)) return normalized.toUpperCase();
      return normalized.length === 1 ? normalized.toUpperCase() : normalized;
  }
}

function toDisplayAcceleratorPart(
  part: string,
  platform: NodeJS.Platform,
): string {
  const normalized = part.trim().toLowerCase();
  const isMac = platform === 'darwin';
  switch (normalized) {
    case 'cmd':
    case 'command':
      return isMac ? '⌘' : 'Cmd';
    case 'ctrl':
    case 'control':
      return isMac ? '⌃' : 'Ctrl';
    case 'alt':
    case 'option':
      return isMac ? '⌥' : 'Alt';
    case 'shift':
      return isMac ? '⇧' : 'Shift';
    default: {
      const trimmed = part.trim();
      return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
    }
  }
}
