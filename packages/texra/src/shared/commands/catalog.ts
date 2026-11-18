import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';

/** A command's default key chord, in VS Code's tokens (`ctrl+alt+m`); `mac`
 *  replaces `key` on macOS. Each host translates it for itself. */
export interface CommandKeybinding {
  readonly key: string;
  readonly mac?: string;
}

/** What a TeXRA command is, whichever host offers it. */
export interface CommandCatalogEntry {
  readonly id: string;
  readonly title: string;
  /** The label where the full title does not fit (a toolbar, a menu). */
  readonly shortTitle?: string;
  readonly keybinding?: CommandKeybinding;
  /**
   * Settings page, or `page/section`, this command opens. Single source of
   * truth for the command → settings-tab mapping: both hosts derive their
   * `showSettings` handler rows from {@link settingsTabByCommand} instead of
   * hand-mirroring the tab per host.
   */
  readonly settingsTab?: SettingsTarget;
}

/**
 * TeXRA's commands, in the order the VS Code extension lists them (its
 * manifest's order). The extension contributes every one; the desktop app
 * runs some of them beside commands of its own. Where a host shows them and
 * how (an icon, a menu, when a command is enabled) is the host's.
 */
export const COMMAND_CATALOG = [
  { id: 'texra.createSampleProject', title: 'Create Sample Project' },
  { id: 'texra.runSetupAssistant', title: 'Run Setup Assistant' },
  {
    id: 'texra.openGettingStarted',
    title: 'Open Getting Started Walkthrough',
  },
  {
    id: 'texra.cleanBuild',
    title: 'Delete All build/ Folders in Workspace',
  },
  {
    id: 'texra.cloneOverleafProject',
    title: 'Clone Overleaf/ShareLaTeX Project',
  },
  { id: 'texra.indentCurrentTeX', title: 'Format Current LaTeX File' },
  { id: 'texra.fixCompilation', title: 'Fix LaTeX Compilation Errors' },
  { id: 'texra.getTeXCount', title: 'Count Words in Current TeX File' },
  {
    id: 'texra.compileTikzFigures',
    title: 'Compile TikZ Figures from Current File',
  },
  { id: 'texra.downloadArXivSource', title: 'Download arXiv Source' },
  {
    id: 'texra.execute',
    title: 'Execute Agent',
    keybinding: { key: 'ctrl+alt+e', mac: 'cmd+option+e' },
  },
  { id: 'texra.setApiKey', title: 'Set API Key' },
  { id: 'texra.removeApiKey', title: 'Remove API Key' },
  {
    id: 'texra.auth.chatgpt.signIn',
    title: 'Sign In with ChatGPT Subscription',
  },
  { id: 'texra.showMemory', title: 'Memory Settings', settingsTab: 'memory' },
  {
    id: 'texra.showModels',
    title: 'Model Settings',
    settingsTab: 'models/models',
  },
  {
    id: 'texra.showAgents',
    title: 'Agent Settings',
    settingsTab: 'agents/library',
  },
  { id: 'texra.showTools', title: 'Plugin Settings', settingsTab: 'plugins' },
  {
    id: 'texra.showApprovalSettings',
    title: 'Approval Settings',
    settingsTab: 'general/approval',
  },
  {
    id: 'texra.showGitSettings',
    title: 'Git Settings',
    settingsTab: 'general/git',
  },
  {
    id: 'texra.showMainView',
    title: 'New Task',
    keybinding: { key: 'ctrl+alt+m', mac: 'cmd+option+m' },
  },
  {
    id: 'texra.showProgressView',
    title: 'Show Tasks',
    keybinding: { key: 'ctrl+alt+p', mac: 'cmd+option+p' },
  },
  {
    id: 'texra.openProgressViewInTab',
    title: 'Open Tasks in Editor',
    shortTitle: 'Open in Editor',
  },
  { id: 'texra.showDashboard', title: 'Open Settings', shortTitle: 'Settings' },
  { id: 'texra.replyComment', title: 'Reply' },
  { id: 'texra.resolveCommentThread', title: 'Resolve' },
  { id: 'texra.unresolveCommentThread', title: 'Reopen' },
] as const satisfies readonly CommandCatalogEntry[];

/** A TeXRA command's id: persisted in keybindings and settings, never
 *  renamed. */
export type CommandId = (typeof COMMAND_CATALOG)[number]['id'];

/** Each command's row by its id. */
export const commandCatalogById: ReadonlyMap<CommandId, CommandCatalogEntry> =
  new Map(COMMAND_CATALOG.map((entry) => [entry.id, entry]));

/** Ids of the catalog entries that open the settings view on a specific tab. */
export type SettingsTabCommandId = Extract<
  (typeof COMMAND_CATALOG)[number],
  { settingsTab: SettingsTarget }
>['id'];

/**
 * Command → settings panel, derived from the `settingsTab` catalog field.
 * Both hosts build their `showSettings` handler rows from this map.
 */
// cast: each entry with a `settingsTab` keys its own id: exactly SettingsTabCommandId.
export const settingsTabByCommand = Object.fromEntries(
  COMMAND_CATALOG.flatMap((entry) =>
    'settingsTab' in entry ? [[entry.id, entry.settingsTab]] : [],
  ),
) as Record<SettingsTabCommandId, SettingsTarget>;
