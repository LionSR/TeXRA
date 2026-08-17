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
    id: 'texra.cleanOutput',
    extensionRegistry: true,
    title: 'Clean All LLM Output Files (Workspace-wide)',
    shortTitle: 'Clean LLM Outputs',
    category: 'TeXRA',
    icon: '$(clear-all)',
  },
  {
    id: 'texra.cleanBuild',
    extensionRegistry: true,
    title: 'Clean All Build Files (Workspace-wide)',
    shortTitle: 'Clean Build Files',
    category: 'TeXRA',
    icon: '$(close-all)',
  },
  {
    id: 'texra.indentTeX',
    extensionRegistry: true,
    title: 'Indent All LaTeX Files',
    category: 'TeXRA',
    icon: '$(indent)',
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
    title: 'Indent Current TeX',
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
    id: 'texra.showImportOptions',
    extensionRegistry: true,
    title: 'Import or Create LaTeX Project',
    category: 'TeXRA',
    icon: '$(cloud-download)',
  },
  {
    id: 'texra.stopAgent',
    extensionRegistry: true,
    title: 'Stop Agent',
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
    id: 'texra.pack',
    extensionRegistry: true,
    title: 'Pack Output into History Folder',
    shortTitle: 'Pack Output',
    category: 'TeXRA',
    icon: '$(archive)',
  },
  {
    id: 'texra.clean',
    extensionRegistry: true,
    title: 'Clean Agent Output Files',
    shortTitle: 'Clean Output',
    category: 'TeXRA',
    icon: '$(trash)',
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
    title: 'Sign In',
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
    id: 'texra.auth.grok.signIn',
    extensionRegistry: true,
    title: 'Sign In with Grok Subscription',
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
    title: 'View Profile',
    category: 'TeXRA',
    icon: '$(account)',
  },
  {
    id: 'texra.openDoc',
    extensionRegistry: true,
    title: 'Open TeXRA Documentation',
    category: 'TeXRA',
  },
  {
    id: 'texra.mainView.reset',
    extensionRegistry: true,
    title: 'New Session',
    shortTitle: 'New',
    category: 'TeXRA',
    icon: '$(new-file)',
  },
  {
    id: 'texra.showMemory',
    extensionRegistry: true,
    title: 'Show Memory',
    category: 'TeXRA',
    icon: '$(database)',
  },
  {
    id: 'texra.showModels',
    extensionRegistry: true,
    title: 'Show Models',
    category: 'TeXRA',
    icon: '$(hubot)',
  },
  {
    id: 'texra.showAgents',
    extensionRegistry: true,
    title: 'Show Agents',
    category: 'TeXRA',
    icon: '$(symbol-method)',
  },
  {
    id: 'texra.showTools',
    extensionRegistry: true,
    title: 'Show Tool Dashboard',
    category: 'TeXRA',
    icon: '$(tools)',
  },
  {
    id: 'texra.showMultiAgent',
    extensionRegistry: true,
    title: 'Show Multi-Agent Settings',
    category: 'TeXRA',
    icon: '$(organization)',
  },
  {
    id: 'texra.showGitSettings',
    extensionRegistry: true,
    title: 'Show Git Settings',
    category: 'TeXRA',
    icon: '$(git-branch)',
  },
  {
    id: 'texra.showMainView',
    title: 'Show Launcher',
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
    title: 'Show Progress',
    category: 'TeXRA',
    icon: '$(eye)',
    keybinding: {
      key: 'ctrl+alt+p',
      mac: 'cmd+option+p',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.toggleView',
    extensionRegistry: true,
    title: 'Toggle Launcher/Progress View',
    category: 'TeXRA',
    icon: '$(split-horizontal)',
    keybinding: {
      key: 'ctrl+alt+t',
      mac: 'cmd+option+t',
      when: 'texra.activated && focusedView == texra.mainView',
    },
  },
  {
    id: 'texra.openProgressViewInTab',
    extensionRegistry: true,
    title: 'Open Progress in Editor Tab',
    shortTitle: 'Open in Tab',
    category: 'TeXRA',
    icon: '$(multiple-windows)',
  },
  {
    id: 'texra.showDashboard',
    extensionRegistry: true,
    title: 'Show Settings Dashboard',
    shortTitle: 'Settings',
    category: 'TeXRA',
    icon: '$(gear)',
  },
  {
    id: 'texra.agentReview.run',
    title: 'Find Issues (Agent Review)',
    shortTitle: 'Find Issues',
    category: 'TeXRA',
    icon: '$(search)',
  },
  {
    id: 'texra.agentReview.runWithOptions',
    title: 'Find Issues with Options (Agent Review)',
    shortTitle: 'Options…',
    category: 'TeXRA',
    icon: '$(ellipsis)',
  },
  {
    id: 'texra.agentReview.stop',
    title: 'Stop Agent Review',
    shortTitle: 'Stop',
    category: 'TeXRA',
    icon: '$(debug-stop)',
  },
  {
    id: 'texra.agentReview.fixAllIssues',
    title: 'Fix All Agent Review Issues',
    shortTitle: 'Fix All Issues',
    category: 'TeXRA',
    icon: '$(tools)',
  },
  {
    id: 'texra.agentReview.fixIssue',
    title: 'Fix with Agent',
    category: 'TeXRA',
    icon: '$(wand)',
  },
  {
    id: 'texra.agentReview.dismissIssue',
    title: 'Dismiss Agent Review Issue',
    shortTitle: 'Dismiss',
    category: 'TeXRA',
    icon: '$(close)',
  },
  {
    id: 'texra.agentReview.openIssue',
    title: 'Open Agent Review Issue',
    category: 'TeXRA',
  },
  {
    id: 'texra.agentReview.clear',
    title: 'Clear Agent Review Results',
    category: 'TeXRA',
    icon: '$(clear-all)',
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
] as const satisfies readonly CommandCatalogEntry[];

export type CommandId = (typeof commandCatalog)[number]['id'];

/**
 * A `contributes.commands` row in `packages/extension/package.json`. Field
 * order mirrors the manifest so the codegen script writes a stable diff.
 */
export interface PackageCommandContribution {
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
).map((entry) => ({
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

const commandKeybindingOrder = [
  'texra.showMainView',
  'texra.showProgressView',
  'texra.toggleView',
  'texra.execute',
] as const satisfies readonly CommandId[];

export const commandKeybindings = commandKeybindingOrder.map((id) => {
  const keybinding = commandCatalogById.get(id)?.keybinding;
  if (!keybinding) {
    throw new Error(`Command has no keybinding: ${id}`);
  }
  return { command: id, ...keybinding };
});
