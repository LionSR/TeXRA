import type { StreamTabId } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { type AgentCategory } from '@shared/schemas/agent';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import {
  formatDesktopAccelerator,
  toElectronAccelerator,
  toPlatformAccelerator,
} from '@shared/commands/accelerators';
import { commandCatalogById, type CommandId } from '@shared/commands/catalog';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import type { MenuItemConstructorOptions } from 'electron';

import type { DesktopRoute } from './desktopShellMessages.js';

export { SETTINGS_TAB };
export { formatDesktopAccelerator };

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
    'texra.showGitSettings',
    'texra.openGettingStarted',
    'texra.cleanOutput',
    'texra.cleanBuild',
  ],
] as const satisfies readonly (readonly (
  CommandId | DesktopLocalCommandId
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
  DesktopFileCommandId | DesktopMenuCommandId | DesktopHelpCommandId;

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

/** Menu template shape produced before Electron materializes native menus. */
export interface DesktopMenuTemplateItem extends Omit<
  MenuItemConstructorOptions,
  'click' | 'submenu'
> {
  click?: () => void;
  submenu?: DesktopMenuTemplateItem[];
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
      const localEntry = DESKTOP_LOCAL_COMMAND_ENTRIES.get(id);
      if (!localEntry) throw new Error(`Missing desktop command entry: ${id}`);
      return {
        ...localEntry,
        accelerator: toPlatformAccelerator(localEntry.accelerator, platform),
      };
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

type DesktopCommandHandler = CommandHandler<DesktopCommandActions>;

// Run an always-present action and report the command as handled.
function requiredAction(
  run: (actions: DesktopCommandActions) => void,
): DesktopCommandHandler {
  return (actions) => {
    run(actions);
    return true;
  };
}

// Run an optional action when the host wired it. Report the command as
// unhandled when the action is absent so the dispatcher can fall through.
function optionalAction(
  pick: (actions: DesktopCommandActions) => (() => void) | undefined,
): DesktopCommandHandler {
  return (actions) => {
    const run = pick(actions);
    if (!run) return false;
    run();
    return true;
  };
}

const DESKTOP_COMMAND_HANDLERS = {
  'texra.showMainView': requiredAction((a) => a.showRoute('main')),
  'texra.showProgressView': requiredAction((a) => a.showRoute('progress')),
  [DESKTOP_LOCAL_COMMANDS.SHOW_LOGS]: requiredAction((a) =>
    a.showRoute('logs'),
  ),
  'texra.openSettings': requiredAction((a) => a.showSettings()),
  'texra.mainView.reset': optionalAction((a) => a.resetMainView),
  'texra.showMemory': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.MEMORY),
  ),
  'texra.showAgentHistory': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.HISTORY),
  ),
  'texra.showModels': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.MODELS),
  ),
  'texra.showAgents': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.AGENTS),
  ),
  'texra.showTools': requiredAction((a) => a.showSettings(SETTINGS_TAB.TOOLS)),
  'texra.showMultiAgent': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.MULTI_AGENT),
  ),
  'texra.showGitSettings': requiredAction((a) =>
    a.showSettings(SETTINGS_TAB.GIT),
  ),
  [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: optionalAction(
    (a) => a.openLogFolder,
  ),
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: optionalAction(
    (a) => a.openWorkspaceFolder,
  ),
  [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW]: optionalAction(
    (a) => a.openWorkspaceInNewWindow,
  ),
  [DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH]: optionalAction(
    (a) => a.showFirstRunWalkthrough,
  ),
  [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: optionalAction(
    (a) => a.openDesktopDocs,
  ),
} as const satisfies Record<DesktopAvailableCommandId, DesktopCommandHandler>;

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
      // The unavailable-command IDs (texra.execute etc.) are valid menu
      // entries with no handler by design — silent fallthrough is correct.
      // Only IDs absent from both the registry AND the unavailable list
      // indicate a stale IPC payload or schema drift; surface those at
      // error level so the bug shows up in support logs without crashing
      // the click handler / IPC dispatcher.
      if (DESKTOP_UNAVAILABLE_COMMANDS.has(failure.id as CommandId)) return;
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
): DesktopMenuTemplateItem[] {
  const entriesById = new Map(
    getDesktopCommandMenuEntries(DESKTOP_COMMAND_IDS, platform).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const commandItem = (id: DesktopCommandId): DesktopMenuTemplateItem => {
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
  const customMenu: DesktopMenuTemplateItem = {
    label: 'TeXRA',
    submenu: [
      ...DESKTOP_MENU_GROUPS[0].map(commandItem),
      { type: 'separator' },
      ...DESKTOP_MENU_GROUPS[1].map(commandItem),
    ],
  };
  const fileMenu: DesktopMenuTemplateItem = {
    label: 'File',
    submenu: [
      ...DESKTOP_FILE_COMMANDS.map(commandItem),
      { type: 'separator' },
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const leadingMenus: DesktopMenuTemplateItem[] =
    platform === 'darwin' ? [{ role: 'appMenu' }, fileMenu] : [fileMenu];

  return [
    ...leadingMenus,
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
