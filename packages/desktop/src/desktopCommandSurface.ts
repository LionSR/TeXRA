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
  OPEN_LOG_FOLDER: 'texra.desktop.openLogFolder',
  OPEN_WORKSPACE_FOLDER: 'texra.desktop.openWorkspaceFolder',
  SHOW_FIRST_RUN_WALKTHROUGH: 'texra.desktop.showFirstRunWalkthrough',
} as const;

type DesktopLocalCommandId =
  (typeof DESKTOP_LOCAL_COMMANDS)[keyof typeof DESKTOP_LOCAL_COMMANDS];

export const DESKTOP_COMMAND_IDS = [
  'texra.showMainView',
  'texra.showProgressView',
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
  DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
  'texra.openSettings',
  'texra.showMemory',
  'texra.showAgentHistory',
  'texra.showModels',
  'texra.showAgents',
  'texra.showTools',
  'texra.showMultiAgent',
] as const satisfies readonly (CommandId | DesktopLocalCommandId)[];

export type DesktopCommandId = (typeof DESKTOP_COMMAND_IDS)[number];

export interface DesktopCommandMenuEntry {
  id: DesktopCommandId;
  label: string;
  category: string;
  accelerator?: string;
}

export interface DesktopCommandActions {
  showRoute(route: DesktopRoute): void;
  showSettings(tabIndex?: SettingsTab, agentSubTab?: AgentCategory): void;
  openLogFolder?(): void;
  openWorkspaceFolder?(): void;
  showFirstRunWalkthrough?(): void;
}

export interface DesktopSettingsTabMessage {
  command: typeof SETTINGS_VIEW_COMMANDS.SET_TAB;
  tabIndex: SettingsTab;
  agentSubTab?: AgentCategory;
}

const DESKTOP_MENU_GROUPS = [
  [
    'texra.showMainView',
    'texra.showProgressView',
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
    DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    'texra.openSettings',
  ],
  [
    'texra.showMemory',
    'texra.showAgentHistory',
    'texra.showModels',
    'texra.showAgents',
    'texra.showTools',
    'texra.showMultiAgent',
  ],
] as const satisfies readonly (readonly DesktopCommandId[])[];

const DESKTOP_HELP_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
] as const satisfies readonly DesktopCommandId[];

const DESKTOP_LOCAL_COMMAND_ENTRIES = new Map<
  DesktopLocalCommandId,
  DesktopCommandMenuEntry
>([
  [
    DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
    {
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
      label: 'Open Folder',
      category: 'TeXRA',
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
      label: 'Show First-Run Walkthrough',
      category: 'Help',
    },
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

    const accelerator =
      entry.keybinding == null
        ? undefined
        : toElectronAccelerator(entry.keybinding, platform);
    return {
      id,
      label: entry.shortTitle ?? entry.title,
      category: entry.category,
      ...(accelerator && { accelerator }),
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
    case 'texra.openSettings':
      actions.showSettings();
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
      actions.openLogFolder?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER:
      actions.openWorkspaceFolder?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH:
      actions.showFirstRunWalkthrough?.();
      return true;
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
      click: () => {
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
