import type { SettingsTarget } from '@shared/settingsView/settingsViewMessages';

export interface CommandKeybinding {
  key: string;
  mac?: string;
  when?: string;
}

export interface CommandCatalogEntry {
  id: string;
  title: string;
  shortTitle?: string;
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
   * Set on entries whose VS Code extension registration goes through the
   * shared `dispatchCommandFromRegistry` handler map (see
   * `packages/extension/src/commands/extensionCommandHandlers.ts`) rather
   * than a bespoke `vscode.commands.registerCommand` call elsewhere.
   * Untagged entries are still valid commands — they're registered
   * directly by other command modules — this flag only marks membership
   * in the shared-registry surface so it can be derived instead of hand-
   * mirrored.
   */
  extensionRegistry?: true;
  /**
   * Set on rows only the desktop app owns. They carry the same identity
   * fields as every other row (title, category, keybinding), so the desktop
   * menus, palette and shortcut registry read one table — but they have no VS
   * Code registration, so {@link packageCommandContributions} filters them
   * out of the extension manifest.
   */
  host?: 'desktop';
}

export const commandCatalog = [
  {
    id: 'texra.createSampleProject',
    extensionRegistry: true,
    title: 'Create Sample Project',
    category: 'TeXRA',
  },
  {
    id: 'texra.runSetupAssistant',
    extensionRegistry: true,
    title: 'Run Setup Assistant',
    category: 'TeXRA',
    icon: '$(rocket)',
  },
  {
    id: 'texra.openGettingStarted',
    extensionRegistry: true,
    title: 'Open Getting Started Walkthrough',
    category: 'TeXRA',
    icon: '$(mortar-board)',
  },
  {
    id: 'texra.cleanBuild',
    extensionRegistry: true,
    title: 'Delete All build/ Folders in Workspace',
    category: 'TeXRA',
    icon: '$(close-all)',
  },
  {
    id: 'texra.cloneOverleafProject',
    extensionRegistry: true,
    title: 'Clone Overleaf/ShareLaTeX Project',
    category: 'TeXRA',
    icon: '$(repo-clone)',
  },
  {
    id: 'texra.indentCurrentTeX',
    extensionRegistry: true,
    title: 'Format Current LaTeX File',
    category: 'TeXRA',
    icon: '$(indent)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.fixCompilation',
    extensionRegistry: true,
    title: 'Fix LaTeX Compilation Errors',
    category: 'TeXRA',
    icon: '$(wrench)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.getTeXCount',
    extensionRegistry: true,
    title: 'Count Words in Current TeX File',
    category: 'TeXRA',
    icon: '$(symbol-number)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.extractTikzFigures',
    extensionRegistry: true,
    title: 'Extract TikZ Figures from Current File',
    category: 'TeXRA',
  },
  {
    id: 'texra.compileTikzFigures',
    extensionRegistry: true,
    title: 'Compile TikZ Figures from Current File',
    category: 'TeXRA',
  },
  {
    id: 'texra.downloadArXivSource',
    extensionRegistry: true,
    title: 'Download arXiv Source',
    category: 'TeXRA',
  },
  {
    id: 'texra.execute',
    extensionRegistry: true,
    title: 'Execute Agent',
    category: 'TeXRA',
    keybinding: {
      key: 'ctrl+alt+e',
      mac: 'cmd+option+e',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.createAgentWithAI',
    extensionRegistry: true,
    title: 'Create AI Agent',
    category: 'TeXRA',
    icon: '$(sparkle)',
  },
  {
    id: 'texra.setApiKey',
    extensionRegistry: true,
    title: 'Set API Key',
    category: 'TeXRA',
  },
  {
    id: 'texra.removeApiKey',
    extensionRegistry: true,
    title: 'Remove API Key',
    category: 'TeXRA',
  },
  {
    id: 'texra.auth.signIn',
    extensionRegistry: true,
    title: 'Sign In to TeXRA Account (Remote Agents)',
    category: 'TeXRA',
    icon: '$(sign-in)',
  },
  {
    id: 'texra.auth.chatgpt.signIn',
    extensionRegistry: true,
    title: 'Sign In with ChatGPT Subscription',
    category: 'TeXRA',
    icon: '$(comment-discussion)',
  },
  {
    id: 'texra.auth.signOut',
    extensionRegistry: true,
    title: 'Sign Out',
    category: 'TeXRA',
    icon: '$(sign-out)',
  },
  {
    id: 'texra.auth.viewProfile',
    extensionRegistry: true,
    title: 'Account Settings',
    category: 'TeXRA',
    icon: '$(account)',
    settingsTab: 'general/account',
  },
  {
    id: 'texra.showMemory',
    extensionRegistry: true,
    title: 'Memory Settings',
    category: 'TeXRA',
    icon: '$(database)',
    settingsTab: 'memory',
  },
  {
    id: 'texra.showModels',
    extensionRegistry: true,
    title: 'Model Settings',
    category: 'TeXRA',
    icon: '$(hubot)',
    settingsTab: 'models/models',
  },
  {
    id: 'texra.showAgents',
    extensionRegistry: true,
    title: 'Agent Settings',
    category: 'TeXRA',
    icon: '$(symbol-method)',
    settingsTab: 'agents/library',
  },
  {
    id: 'texra.showTools',
    extensionRegistry: true,
    title: 'Tool Settings',
    category: 'TeXRA',
    icon: '$(tools)',
    settingsTab: 'tools/tools',
  },
  {
    id: 'texra.showMultiAgent',
    extensionRegistry: true,
    title: 'Agent Team Settings',
    category: 'TeXRA',
    icon: '$(organization)',
    settingsTab: 'agents/teams',
  },
  {
    id: 'texra.showGitSettings',
    extensionRegistry: true,
    title: 'Git Settings',
    category: 'TeXRA',
    icon: '$(git-branch)',
    settingsTab: 'general/git',
  },
  {
    id: 'texra.showMainView',
    extensionRegistry: true,
    title: 'New Task',
    category: 'TeXRA',
    icon: '$(edit)',
    keybinding: {
      key: 'ctrl+alt+m',
      mac: 'cmd+option+m',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.showProgressView',
    extensionRegistry: true,
    title: 'Show Sessions',
    category: 'TeXRA',
    icon: '$(eye)',
    keybinding: {
      key: 'ctrl+alt+p',
      mac: 'cmd+option+p',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.openProgressViewInTab',
    extensionRegistry: true,
    title: 'Open Sessions in Editor',
    shortTitle: 'Open in Editor',
    category: 'TeXRA',
    icon: '$(multiple-windows)',
  },
  {
    id: 'texra.showDashboard',
    extensionRegistry: true,
    title: 'Open Settings',
    shortTitle: 'Settings',
    category: 'TeXRA',
    icon: '$(gear)',
  },
  {
    id: 'texra.replyComment',
    title: 'Reply',
    category: 'TeXRA',
  },
  {
    id: 'texra.resolveCommentThread',
    title: 'Resolve',
    category: 'TeXRA',
    icon: '$(check)',
  },
  {
    id: 'texra.unresolveCommentThread',
    title: 'Reopen',
    category: 'TeXRA',
    icon: '$(history)',
  },
  // Desktop-only rows (`host: 'desktop'`): no VS Code registration, so they
  // stay out of the extension manifest. Icons are a desktop concern and live
  // with the desktop menu wiring.
  {
    id: 'texra.desktop.showLogs',
    host: 'desktop',
    title: 'Show Logs',
    category: 'TeXRA',
  },
  {
    id: 'texra.desktop.openLogFolder',
    host: 'desktop',
    title: 'Open Logs Folder',
    category: 'TeXRA',
  },
  {
    id: 'texra.desktop.showCommands',
    host: 'desktop',
    title: 'Show Commands',
    shortTitle: 'Commands',
    category: 'TeXRA',
    keybinding: { key: 'ctrl+k', mac: 'cmd+k' },
  },
  {
    id: 'texra.desktop.toggleBottomBar',
    host: 'desktop',
    title: 'Toggle Bottom Bar',
    category: 'View',
    keybinding: { key: 'ctrl+j', mac: 'cmd+j' },
  },
  {
    id: 'texra.desktop.toggleSidePanel',
    host: 'desktop',
    title: 'Toggle Side Panel',
    category: 'View',
    keybinding: { key: 'ctrl+alt+b', mac: 'cmd+option+b' },
  },
  {
    id: 'texra.desktop.saveFile',
    host: 'desktop',
    title: 'Save',
    category: 'File',
    keybinding: { key: 'ctrl+s', mac: 'cmd+s' },
  },
  {
    id: 'texra.desktop.openWorkspaceFolder',
    host: 'desktop',
    title: 'Open Folder',
    category: 'File',
    keybinding: { key: 'ctrl+o', mac: 'cmd+o' },
  },
  {
    id: 'texra.desktop.showFirstRunWalkthrough',
    host: 'desktop',
    title: 'Show Startup Team Chooser',
    category: 'Help',
  },
  {
    id: 'texra.desktop.openDesktopDocs',
    host: 'desktop',
    title: 'Desktop Documentation',
    category: 'Help',
  },
] as const satisfies readonly CommandCatalogEntry[];

export type CommandId = (typeof commandCatalog)[number]['id'];

/**
 * A `contributes.commands` row in `packages/extension/package.json`. Field
 * order mirrors the manifest so the codegen script writes a stable diff.
 */
interface PackageCommandContribution {
  command: string;
  title: string;
  shortTitle?: string;
  category: string;
  icon?: string;
  enablement?: string;
}

/**
 * The `contributes.commands` array, derived from {@link commandCatalog}. This
 * is the single source of truth: `scripts/sync-package-contributes.mjs` writes
 * it into `package.json`, and `CommandCatalog.vitest.ts` diff-checks it.
 */
export const packageCommandContributions: PackageCommandContribution[] = (
  commandCatalog as readonly CommandCatalogEntry[]
)
  .filter((entry) => entry.host !== 'desktop')
  .map((entry) => ({
    command: entry.id,
    title: entry.title,
    ...(entry.shortTitle === undefined ? {} : { shortTitle: entry.shortTitle }),
    category: entry.category,
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.enablement === undefined ? {} : { enablement: entry.enablement }),
  }));

export const commandCatalogById = new Map<CommandId, CommandCatalogEntry>(
  commandCatalog.map((entry) => [entry.id, entry]),
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
export const settingsTabByCommand = Object.fromEntries(
  commandCatalog.flatMap((entry) =>
    'settingsTab' in entry ? [[entry.id, entry.settingsTab]] : [],
  ),
) as Record<SettingsTabCommandId, SettingsTarget>;

const commandKeybindingOrder = [
  'texra.showMainView',
  'texra.showProgressView',
  'texra.execute',
] as const satisfies readonly CommandId[];

export const commandKeybindings = commandKeybindingOrder.map((id) => {
  const keybinding = commandCatalogById.get(id)?.keybinding;
  if (!keybinding) {
    throw new Error(`Command has no keybinding: ${id}`);
  }
  return { command: id, ...keybinding };
});
