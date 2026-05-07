import {
  commandCatalogById,
  type CommandId,
  type CommandKeybinding,
} from '@commands/catalog';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { type AgentCategory } from '@shared/schemas/agent';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopRoute } from './desktopShellMessages.js';

export const DESKTOP_LOCAL_COMMANDS = {
  SHOW_LOGS: 'texra.desktop.showLogs',
  OPEN_LOG_FOLDER: 'texra.desktop.openLogFolder',
  OPEN_WORKSPACE_FOLDER: 'texra.desktop.openWorkspaceFolder',
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
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
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

const DESKTOP_HELP_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

type DesktopMenuCommandId = (typeof DESKTOP_MENU_GROUPS)[number][number];
type DesktopHelpCommandId = (typeof DESKTOP_HELP_COMMANDS)[number];
export type DesktopCommandId = DesktopMenuCommandId | DesktopHelpCommandId;

export const DESKTOP_COMMAND_IDS: readonly DesktopCommandId[] = [
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
  openDesktopDocs?(): void;
  openLogFolder?(): void;
  openWorkspaceFolder?(): void;
  showFirstRunWalkthrough?(): void;
  resetMainView?(): void;
}

export interface DesktopSettingsTabMessage {
  command: typeof SETTINGS_VIEW_COMMANDS.SET_TAB;
  tabIndex: SettingsTab;
  agentSubTab?: AgentCategory;
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
      category: 'TeXRA',
      accelerator: 'CommandOrControl+O',
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

const DESKTOP_UNAVAILABLE_COMMANDS = new Map<CommandId, string>([
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
]);

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

export function dispatchDesktopCommand(
  id: DesktopCommandId,
  actions: DesktopCommandActions,
): boolean {
  switch (id) {
    case 'texra.showMainView':
      actions.showRoute('main');
      return true;
    case 'texra.showProgressView':
      actions.showRoute('progress');
      return true;
    case DESKTOP_LOCAL_COMMANDS.SHOW_LOGS:
      actions.showRoute('logs');
      return true;
    case 'texra.openSettings':
      actions.showSettings();
      return true;
    case 'texra.mainView.reset':
      if (!actions.resetMainView) return false;
      actions.resetMainView();
      return true;
    case 'texra.showMemory':
      actions.showSettings(SETTINGS_TAB.MEMORY);
      return true;
    case 'texra.showAgentHistory':
      actions.showSettings(SETTINGS_TAB.HISTORY);
      return true;
    case 'texra.showModels':
      actions.showSettings(SETTINGS_TAB.MODELS);
      return true;
    case 'texra.showAgents':
      actions.showSettings(SETTINGS_TAB.AGENTS);
      return true;
    case 'texra.showTools':
      actions.showSettings(SETTINGS_TAB.TOOLS);
      return true;
    case 'texra.showMultiAgent':
      actions.showSettings(SETTINGS_TAB.MULTI_AGENT);
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER:
      if (!actions.openLogFolder) return false;
      actions.openLogFolder();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER:
      if (!actions.openWorkspaceFolder) return false;
      actions.openWorkspaceFolder();
      return true;
    case DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH:
      actions.showFirstRunWalkthrough?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS:
      actions.openDesktopDocs?.();
      return true;
    case 'texra.execute':
    case 'texra.runSetupAssistant':
    case 'texra.showImportOptions':
    case 'texra.openGettingStarted':
    case 'texra.cleanOutput':
    case 'texra.cleanBuild':
      return false;
    default:
      return assertNever(id);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled desktop command: ${value}`);
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

  return [
    ...(platform === 'darwin'
      ? ([
          { role: 'appMenu' },
          { role: 'fileMenu' },
        ] satisfies MenuItemConstructorOptions[])
      : ([{ role: 'fileMenu' }] satisfies MenuItemConstructorOptions[])),
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
