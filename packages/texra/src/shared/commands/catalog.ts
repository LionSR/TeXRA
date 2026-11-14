import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';

export interface CommandKeybinding {
  key: string;
  mac?: string;
  when?: string;
}

interface CommandCatalogEntry {
  id: string;
  title: string;
  shortTitle?: string;
  /** The palette group. Every extension command is in {@link EXTENSION_COMMAND_CATEGORY}. */
  category: string;
  icon?: string;
  enablement?: string;
  keybinding?: CommandKeybinding;
  /**
   * Settings page, or `page/section`, this command opens. Single source of
   * truth for the command → settings-tab mapping: both hosts derive their `showSettings`
   * handler rows from {@link settingsTabByCommand} instead of hand-mirroring
   * the tab per host.
   */
  settingsTab?: SettingsTarget;
  /**
   * `false` hides the command from VS Code's command palette: it is reached
   * from a button, a keybinding or a comment thread instead. Every other
   * extension row shows there once the window has activated.
   */
  palette?: false;
}

/** The palette group of every command the extension contributes. */
const EXTENSION_COMMAND_CATEGORY = 'TeXRA';

/** An extension row: its category is {@link EXTENSION_COMMAND_CATEGORY}. */
type ExtensionCommandEntry = Omit<CommandCatalogEntry, 'category'>;

/**
 * The commands the VS Code extension contributes, in manifest order, all in
 * {@link EXTENSION_COMMAND_CATEGORY}. The desktop app runs some of them too.
 */
const commandCatalog = [
  {
    id: 'texra.createSampleProject',
    title: 'Create Sample Project',
  },
  {
    id: 'texra.runSetupAssistant',
    title: 'Run Setup Assistant',
    icon: '$(rocket)',
  },
  {
    id: 'texra.openGettingStarted',
    title: 'Open Getting Started Walkthrough',
    icon: '$(mortar-board)',
  },
  {
    id: 'texra.cleanBuild',
    title: 'Delete All build/ Folders in Workspace',
    icon: '$(close-all)',
  },
  {
    id: 'texra.cloneOverleafProject',
    title: 'Clone Overleaf/ShareLaTeX Project',
    icon: '$(repo-clone)',
  },
  {
    id: 'texra.indentCurrentTeX',
    title: 'Format Current LaTeX File',
    icon: '$(indent)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.fixCompilation',
    title: 'Fix LaTeX Compilation Errors',
    icon: '$(wrench)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.getTeXCount',
    title: 'Count Words in Current TeX File',
    icon: '$(symbol-number)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.compileTikzFigures',
    title: 'Compile TikZ Figures from Current File',
  },
  {
    id: 'texra.downloadArXivSource',
    title: 'Download arXiv Source',
  },
  {
    id: 'texra.execute',
    palette: false,
    title: 'Execute Agent',
    keybinding: {
      key: 'ctrl+alt+e',
      mac: 'cmd+option+e',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.setApiKey',
    title: 'Set API Key',
  },
  {
    id: 'texra.removeApiKey',
    palette: false,
    title: 'Remove API Key',
  },
  {
    id: 'texra.auth.chatgpt.signIn',
    title: 'Sign In with ChatGPT Subscription',
    icon: '$(comment-discussion)',
  },
  {
    id: 'texra.showMemory',
    palette: false,
    title: 'Memory Settings',
    icon: '$(database)',
    settingsTab: 'memory',
  },
  {
    id: 'texra.showModels',
    palette: false,
    title: 'Model Settings',
    icon: '$(hubot)',
    settingsTab: 'models/models',
  },
  {
    id: 'texra.showAgents',
    palette: false,
    title: 'Agent Settings',
    icon: '$(symbol-method)',
    settingsTab: 'agents/library',
  },
  {
    id: 'texra.showTools',
    palette: false,
    title: 'Plugin Settings',
    icon: '$(extensions)',
    settingsTab: 'plugins',
  },
  {
    id: 'texra.showApprovalSettings',
    palette: false,
    title: 'Approval Settings',
    icon: '$(shield)',
    settingsTab: 'general/approval',
  },
  {
    id: 'texra.showTeamSettings',
    palette: false,
    title: 'Agent Team Settings',
    icon: '$(organization)',
    settingsTab: 'agents/teams',
  },
  {
    id: 'texra.showGitSettings',
    palette: false,
    title: 'Git Settings',
    icon: '$(git-branch)',
    settingsTab: 'general/git',
  },
  {
    id: 'texra.showMainView',
    title: 'New Task',
    icon: '$(edit)',
    keybinding: {
      key: 'ctrl+alt+m',
      mac: 'cmd+option+m',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.showProgressView',
    title: 'Show Tasks',
    icon: '$(eye)',
    keybinding: {
      key: 'ctrl+alt+p',
      mac: 'cmd+option+p',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.openProgressViewInTab',
    title: 'Open Tasks in Editor',
    shortTitle: 'Open in Editor',
    icon: '$(multiple-windows)',
  },
  {
    id: 'texra.showDashboard',
    title: 'Open Settings',
    shortTitle: 'Settings',
    icon: '$(gear)',
  },
  {
    id: 'texra.replyComment',
    palette: false,
    title: 'Reply',
  },
  {
    id: 'texra.resolveCommentThread',
    palette: false,
    title: 'Resolve',
    icon: '$(check)',
  },
  {
    id: 'texra.unresolveCommentThread',
    palette: false,
    title: 'Reopen',
    icon: '$(history)',
  },
] as const satisfies readonly ExtensionCommandEntry[];

/**
 * The commands only the desktop app has. They carry the same identity fields
 * as the extension's rows, so the desktop menus, palette and shortcut registry
 * read both tables through {@link commandCatalogById}; the extension manifest
 * reads {@link commandCatalog} alone. Icons are a desktop concern and live
 * with the desktop menu wiring.
 */
const desktopCommandCatalog = [
  {
    id: 'texra.desktop.showLogs',
    title: 'Show Logs',
    category: 'TeXRA',
  },
  {
    id: 'texra.desktop.openLogFolder',
    title: 'Open Logs Folder',
    category: 'TeXRA',
  },
  {
    id: 'texra.desktop.showCommands',
    title: 'Show Commands',
    shortTitle: 'Commands',
    category: 'TeXRA',
    keybinding: { key: 'ctrl+k', mac: 'cmd+k' },
  },
  {
    id: 'texra.desktop.toggleBottomBar',
    title: 'Show Terminal',
    category: 'View',
    keybinding: { key: 'ctrl+j', mac: 'cmd+j' },
  },
  {
    id: 'texra.desktop.toggleSidePanel',
    title: 'Show Files',
    category: 'View',
    keybinding: { key: 'ctrl+alt+b', mac: 'cmd+option+b' },
  },
  {
    id: 'texra.desktop.showBrowser',
    title: 'Show Browser',
    category: 'View',
  },
  {
    id: 'texra.desktop.saveFile',
    title: 'Save',
    category: 'File',
    keybinding: { key: 'ctrl+s', mac: 'cmd+s' },
  },
  {
    id: 'texra.desktop.openWorkspaceFolder',
    title: 'Open Folder',
    category: 'File',
    keybinding: { key: 'ctrl+o', mac: 'cmd+o' },
  },
  {
    id: 'texra.desktop.openDesktopDocs',
    title: 'Desktop Documentation',
    category: 'Help',
  },
] as const satisfies readonly CommandCatalogEntry[];

/** A command the extension contributes. */
export type ExtensionCommandId = (typeof commandCatalog)[number]['id'];

export type CommandId =
  | ExtensionCommandId
  | (typeof desktopCommandCatalog)[number]['id'];

/**
 * A `contributes.commands` row in `packages/extension/package.json`. Field
 * order mirrors the manifest so the codegen script writes a stable diff.
 */
type PackageCommandContribution = { command: string } & Pick<
  CommandCatalogEntry,
  'title' | 'shortTitle' | 'category' | 'icon' | 'enablement'
>;

/**
 * The `contributes.commands` array, derived from {@link commandCatalog}. This
 * is the single source of truth: `scripts/sync-package-contributes.mjs` writes
 * it into `package.json`, and its `--check` (in `npm run gate`) fails on drift.
 */
export const packageCommandContributions: PackageCommandContribution[] =
  commandCatalog.map((entry: ExtensionCommandEntry) => ({
    command: entry.id,
    title: entry.title,
    ...(entry.shortTitle === undefined ? {} : { shortTitle: entry.shortTitle }),
    category: EXTENSION_COMMAND_CATEGORY,
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.enablement === undefined ? {} : { enablement: entry.enablement }),
  }));

/**
 * The manifest's `menus.commandPalette`: every row waits for `texra.activated`,
 * which the extension sets once all its commands are registered, so the
 * palette never offers a command that is not there yet; a `palette: false`
 * row is never shown.
 */
export const packageCommandPalette = commandCatalog.map(
  (entry: ExtensionCommandEntry) => ({
    command: entry.id,
    when: entry.palette === false ? 'false' : 'texra.activated',
  }),
);

/** The manifest's `contributes.keybindings`, in catalog order. */
export const commandKeybindings = commandCatalog.flatMap(
  (entry: ExtensionCommandEntry) =>
    entry.keybinding ? [{ command: entry.id, ...entry.keybinding }] : [],
);

export const commandCatalogById = new Map<CommandId, CommandCatalogEntry>(
  [
    ...commandCatalog.map((entry) => ({
      ...entry,
      category: EXTENSION_COMMAND_CATEGORY,
    })),
    ...desktopCommandCatalog,
  ].map((entry) => [entry.id, entry]),
);

/** Ids of the catalog entries that open the settings view on a specific tab. */
export type SettingsTabCommandId = Extract<
  (typeof commandCatalog)[number],
  { settingsTab: SettingsTarget }
>['id'];

/**
 * Command → settings panel, derived from the `settingsTab` catalog field.
 * Both hosts build their `showSettings` handler rows from this map.
 */
// cast: each entry with a `settingsTab` keys its own id: exactly SettingsTabCommandId.
export const settingsTabByCommand = Object.fromEntries(
  commandCatalog.flatMap((entry) =>
    'settingsTab' in entry ? [[entry.id, entry.settingsTab]] : [],
  ),
) as Record<SettingsTabCommandId, SettingsTarget>;
