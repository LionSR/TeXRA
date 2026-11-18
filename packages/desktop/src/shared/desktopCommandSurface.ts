import { Schema } from 'effect';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import {
  commandCatalogById,
  settingsTabByCommand,
  type CommandId,
  type SettingsTabCommandId,
} from '@texra/shared/commands/catalog';
import type { IconName } from '@ui/wa/iconNames';
import { SETTINGS_NAV_ENTRIES } from '@ui/settings/settingsNav';
import { texraGuideUrl } from '@ui/copy/guide';
import { toElectronAccelerator } from './accelerators';
import type { OsPlatform } from '@texra/shared/osPlatform';
import { DESKTOP_SHELL_COMMANDS } from './desktopShellMessages.js';
import type { DesktopPush } from './desktopOutboundMessages.js';

export const DESKTOP_LOCAL_COMMANDS = {
  SHOW_LOGS: 'texra.desktop.showLogs',
  SHOW_BROWSER: 'texra.desktop.showBrowser',
  TOGGLE_BOTTOM_BAR: 'texra.desktop.toggleBottomBar',
  TOGGLE_SIDE_PANEL: 'texra.desktop.toggleSidePanel',
  OPEN_LOG_FOLDER: 'texra.desktop.openLogFolder',
  OPEN_WORKSPACE_FOLDER: 'texra.desktop.openWorkspaceFolder',
  SAVE_FILE: 'texra.desktop.saveFile',
  SWITCH_PROJECT: 'texra.desktop.switchProject',
  OPEN_DESKTOP_DOCS: 'texra.desktop.openDesktopDocs',
} as const;

export const DESKTOP_DOCS_URL = texraGuideUrl('desktop');

type DesktopLocalCommandId =
  (typeof DESKTOP_LOCAL_COMMANDS)[keyof typeof DESKTOP_LOCAL_COMMANDS];

/** Every command the palette lists and the shortcuts reach, in palette
 *  order. The native menu places its items by hand. */
const DESKTOP_PALETTE_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
  DESKTOP_LOCAL_COMMANDS.SWITCH_PROJECT,
  'texra.showMainView',
  DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
  DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
  'texra.showDashboard',
  DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
  DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
  DESKTOP_LOCAL_COMMANDS.SHOW_BROWSER,
  // One row per settings page that has a command, in nav order.
  'texra.showModels',
  'texra.showAgents',
  'texra.showTools',
  'texra.showMemory',
  'texra.showGitSettings',
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly CommandId[];

export type DesktopCommandId = (typeof DESKTOP_PALETTE_COMMANDS)[number];

/**
 * The commands the main process runs itself, since they reach the OS (a
 * browser, a folder, the file picker). The renderer posts these by id; the
 * main process posts every other command to the renderer as
 * `desktop:runCommand`.
 */
export const DESKTOP_MAIN_COMMANDS = [
  DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
  DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
  DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
] as const satisfies readonly DesktopLocalCommandId[];

export type DesktopMainCommandId = (typeof DESKTOP_MAIN_COMMANDS)[number];

/** A native menu click on a command the renderer runs. */
export const DesktopRunCommandMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.RUN_COMMAND),
  id: Schema.Literals(DESKTOP_PALETTE_COMMANDS),
});

const DESKTOP_COMMAND_ICONS = {
  [DESKTOP_LOCAL_COMMANDS.SAVE_FILE]: 'floppy-disk',
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: 'folder-open',
  [DESKTOP_LOCAL_COMMANDS.SWITCH_PROJECT]: 'folder',
  'texra.showMainView': 'pencil',
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: 'file-lines',
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: 'folder',
  'texra.showDashboard': 'gear',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR]: 'terminal',
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL]: 'folder-tree',
  [DESKTOP_LOCAL_COMMANDS.SHOW_BROWSER]: 'globe',
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: 'book',
} as const satisfies Record<
  Exclude<DesktopCommandId, SettingsTabCommandId>,
  IconName
>;

/** A settings command's icon is its page's, as the settings nav shows it;
 *  one that opens a section the nav draws no icon for names its own. */
const SETTINGS_SECTION_ICONS: Partial<Record<SettingsTabCommandId, IconName>> =
  { 'texra.showGitSettings': 'code-branch' };

const settingsPageIcons = new Map<string, IconName>(
  SETTINGS_NAV_ENTRIES.map(({ panel, icon }) => [panel, icon]),
);

function commandIcon(id: DesktopCommandId): IconName {
  if (!isSettingsCommand(id)) return DESKTOP_COMMAND_ICONS[id];
  const page = settingsTabByCommand[id].split('/')[0] ?? '';
  const icon = SETTINGS_SECTION_ICONS[id] ?? settingsPageIcons.get(page);
  if (!icon) throw new Error(`No settings page icon for ${id}`);
  return icon;
}

interface DesktopPaletteEntry {
  id: DesktopCommandId;
  label: string;
  category: string;
  icon: IconName;
  accelerator?: string;
}

/**
 * What the desktop commands do, implemented once, by the renderer, which
 * holds every UI action. The handler map requires every action, so a miswired
 * renderer fails to compile instead of producing a command that silently does
 * nothing.
 */
export interface DesktopCommandActions {
  showLauncher(): void;
  openWorkbench(kind: 'logs' | 'browser'): void;
  showSettings(tab?: SettingsTarget): void;
  openDesktopDocs(): void;
  openLogFolder(): void;
  openWorkspaceFolder(): void;
  saveFile(): void;
  /** Lists the other open projects to choose one to show. */
  switchProject(): void;
  showTerminal(): void;
  showFiles(): void;
}

export function paletteEntries(platform: OsPlatform): DesktopPaletteEntry[] {
  return DESKTOP_PALETTE_COMMANDS.map((id) => {
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
      icon: commandIcon(id),
      ...(accelerator && { accelerator }),
    };
  });
}

const DESKTOP_COMMAND_HANDLERS = {
  'texra.showMainView': (a) => a.showLauncher(),
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: (a) => a.openWorkbench('logs'),
  [DESKTOP_LOCAL_COMMANDS.SHOW_BROWSER]: (a) => a.openWorkbench('browser'),
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR]: (a) => a.showTerminal(),
  [DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL]: (a) => a.showFiles(),
  'texra.showDashboard': (a) => a.showSettings(),
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: (a) => a.openLogFolder(),
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: (a) =>
    a.openWorkspaceFolder(),
  [DESKTOP_LOCAL_COMMANDS.SAVE_FILE]: (a) => a.saveFile(),
  [DESKTOP_LOCAL_COMMANDS.SWITCH_PROJECT]: (a) => a.switchProject(),
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: (a) => a.openDesktopDocs(),
} as const satisfies Record<
  Exclude<DesktopCommandId, SettingsTabCommandId>,
  (actions: DesktopCommandActions) => void
>;

/** Run command `id`. The `texra.show*` settings commands open the page the
 *  catalog names for them, as the extension's do. */
export function dispatchDesktopCommand(
  id: DesktopCommandId,
  actions: DesktopCommandActions,
): void {
  if (isSettingsCommand(id)) actions.showSettings(settingsTabByCommand[id]);
  else DESKTOP_COMMAND_HANDLERS[id](actions);
}

function isSettingsCommand(id: CommandId): id is SettingsTabCommandId {
  return Object.hasOwn(settingsTabByCommand, id);
}

/**
 * Opens the Settings dialog, on `tab` when one is named. The renderer's
 * dialog selects the tab, as it does for its own openings.
 */
export function postDesktopSettingsView(
  postToRenderer: (message: DesktopPush) => void,
  tab?: SettingsTarget,
): void {
  postToRenderer({
    command: DESKTOP_SHELL_COMMANDS.OPEN_SETTINGS,
    ...(tab && { tab }),
  });
}
