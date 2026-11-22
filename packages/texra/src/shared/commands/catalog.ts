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
export const COMMAND_CATALOG = Object.freeze([
  Object.freeze({
    id: 'texra.createSampleProject',
    title: 'Create Sample Project',
  }),
  Object.freeze({
    id: 'texra.runSetupAssistant',
    title: 'Run Setup Assistant',
  }),
  Object.freeze({
    id: 'texra.openGettingStarted',
    title: 'Open Getting Started Walkthrough',
  }),
  Object.freeze({
    id: 'texra.cleanBuild',
    title: 'Delete All build/ Folders in Project',
  }),
  Object.freeze({
    id: 'texra.cloneOverleafProject',
    title: 'Clone Overleaf/ShareLaTeX Project',
  }),
  Object.freeze({
    id: 'texra.indentCurrentTeX',
    title: 'Format Current LaTeX File',
  }),
  Object.freeze({
    id: 'texra.fixCompilation',
    title: 'Fix LaTeX Compilation Errors',
  }),
  Object.freeze({
    id: 'texra.getTeXCount',
    title: 'Count Words in Current LaTeX File',
  }),
  Object.freeze({
    id: 'texra.compileTikzFigures',
    title: 'Compile TikZ Figures from Current File',
  }),
  Object.freeze({
    id: 'texra.downloadArXivSource',
    title: 'Download arXiv Source',
  }),
  Object.freeze({
    id: 'texra.execute',
    title: 'Run Task',
    keybinding: Object.freeze({ key: 'ctrl+alt+e', mac: 'cmd+option+e' }),
  }),
  Object.freeze({ id: 'texra.setApiKey', title: 'Set API Key' }),
  Object.freeze({ id: 'texra.removeApiKey', title: 'Remove API Key' }),
  Object.freeze({
    id: 'texra.auth.chatgpt.signIn',
    title: 'Sign In with ChatGPT Subscription',
  }),
  Object.freeze({
    id: 'texra.showMemory',
    title: 'Memory Settings',
    settingsTab: 'memory',
  }),
  Object.freeze({
    id: 'texra.showModels',
    title: 'Model Settings',
    settingsTab: 'models/models',
  }),
  Object.freeze({
    id: 'texra.showTools',
    title: 'Plugin Settings',
    settingsTab: 'plugins',
  }),
  Object.freeze({
    id: 'texra.showApprovalSettings',
    title: 'Approval Settings',
    settingsTab: 'general/approval',
  }),
  Object.freeze({
    id: 'texra.showGitSettings',
    title: 'Git Settings',
    settingsTab: 'general/git',
  }),
  Object.freeze({
    id: 'texra.showMainView',
    title: 'New Task',
    keybinding: Object.freeze({ key: 'ctrl+alt+m', mac: 'cmd+option+m' }),
  }),
  Object.freeze({
    id: 'texra.showProgressView',
    title: 'Show Tasks',
    keybinding: Object.freeze({ key: 'ctrl+alt+p', mac: 'cmd+option+p' }),
  }),
  Object.freeze({
    id: 'texra.openProgressViewInTab',
    title: 'Open Tasks in Editor',
    shortTitle: 'Open in Editor',
  }),
  Object.freeze({
    id: 'texra.showDashboard',
    title: 'Open Settings',
    shortTitle: 'Settings',
  }),
  Object.freeze({ id: 'texra.replyComment', title: 'Reply' }),
  Object.freeze({ id: 'texra.resolveCommentThread', title: 'Resolve' }),
  Object.freeze({ id: 'texra.unresolveCommentThread', title: 'Reopen' }),
] as const satisfies readonly CommandCatalogEntry[]);

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
export const settingsTabByCommand = Object.freeze(
  Object.fromEntries(
    COMMAND_CATALOG.flatMap((entry) =>
      'settingsTab' in entry ? [[entry.id, entry.settingsTab]] : [],
    ),
  ) as Record<SettingsTabCommandId, SettingsTarget>,
);
