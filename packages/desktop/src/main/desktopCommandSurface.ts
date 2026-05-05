import {
  commandCatalogById,
  type CommandId,
  type CommandKeybinding,
} from '@commands/catalog';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopShellActions } from './desktopShellIpc.js';

export const DESKTOP_COMMAND_IDS = [
  'texra.showMainView',
  'texra.showProgressView',
  'texra.openSettings',
  'texra.showDashboard',
  'texra.showSettingsView',
  'texra.showMemory',
  'texra.showAgentHistory',
  'texra.showModels',
  'texra.showAgents',
  'texra.showTools',
  'texra.showMultiAgent',
] as const satisfies readonly CommandId[];

export type DesktopCommandId = (typeof DESKTOP_COMMAND_IDS)[number];

export interface DesktopCommandMenuEntry {
  id: DesktopCommandId;
  label: string;
  category: string;
  accelerator?: string;
}

const DESKTOP_MENU_GROUPS = [
  ['texra.showMainView', 'texra.showProgressView', 'texra.openSettings'],
  [
    'texra.showMemory',
    'texra.showAgentHistory',
    'texra.showModels',
    'texra.showAgents',
    'texra.showTools',
    'texra.showMultiAgent',
  ],
] as const satisfies readonly (readonly DesktopCommandId[])[];

export function getDesktopCommandMenuEntries(
  ids: readonly DesktopCommandId[] = DESKTOP_COMMAND_IDS,
  platform: NodeJS.Platform = process.platform,
): DesktopCommandMenuEntry[] {
  return ids.map((id) => {
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

export function toElectronAccelerator(
  keybinding: CommandKeybinding,
  platform: NodeJS.Platform = process.platform,
): string {
  const key =
    platform === 'darwin' && keybinding.mac ? keybinding.mac : keybinding.key;
  return key.split('+').map(toElectronAcceleratorPart).join('+');
}

export function dispatchDesktopCommand(
  id: CommandId,
  actions: DesktopShellActions,
): boolean {
  switch (id) {
    case 'texra.showMainView':
      actions.showRoute('main');
      return true;
    case 'texra.showProgressView':
      actions.showRoute('progress');
      return true;
    case 'texra.openSettings':
    case 'texra.showDashboard':
    case 'texra.showSettingsView':
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
    default:
      return false;
  }
}

export function buildDesktopMenuTemplate(
  actions: DesktopShellActions,
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
    { role: 'help' },
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
    default:
      return normalized.length === 1 ? normalized.toUpperCase() : normalized;
  }
}
