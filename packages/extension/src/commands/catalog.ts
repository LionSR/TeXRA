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
}

export const commandCatalog = [
  {
    id: 'texra.createSampleProject',
    title: 'Create Sample Project',
    category: 'TeXRA',
  },
  {
    id: 'texra.runSetupAssistant',
    title: 'Run Setup Assistant Agent (Setup Wizard)',
    category: 'TeXRA',
    icon: '$(rocket)',
  },
  {
    id: 'texra.openGettingStarted',
    title: 'Open Getting Started Walkthrough',
    category: 'TeXRA',
    icon: '$(mortar-board)',
  },
  {
    id: 'texra.cleanOutput',
    title: 'Clean All LLM Output Files (Workspace-wide)',
    shortTitle: 'Clean LLM Outputs',
    category: 'TeXRA',
    icon: '$(clear-all)',
    keybinding: {
      key: 'ctrl+alt+shift+c',
      mac: 'cmd+option+shift+c',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.cleanBuild',
    title: 'Clean All Build Files (Workspace-wide)',
    shortTitle: 'Clean Build Files',
    category: 'TeXRA',
    icon: '$(close-all)',
    keybinding: {
      key: 'ctrl+alt+shift+b',
      mac: 'cmd+option+shift+b',
      when: 'texra.activated',
    },
  },
  {
    id: 'texra.indentTeX',
    title: 'Indent All LaTeX Files',
    category: 'TeXRA',
    icon: '$(indent)',
  },
  {
    id: 'texra.getRecentCommits',
    title: 'Get Recent Commits',
    category: 'TeXRA',
  },
  {
    id: 'texra.cloneOverleafProject',
    title: 'Clone Overleaf/ShareLaTeX Project',
    category: 'TeXRA',
    icon: '$(repo-clone)',
  },
  {
    id: 'texra.refreshCommits',
    title: 'Refresh Commits',
    category: 'TeXRA',
  },
  {
    id: 'texra.indentCurrentTeX',
    title: 'Indent Current TeX',
    category: 'TeXRA',
    icon: '$(indent)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.resumeAgent',
    title: 'Resume Tool-Use Agent',
    category: 'TeXRA',
  },
  {
    id: 'texra.applyReplacements',
    title: 'Apply LaTeX Replacements to Current File',
    category: 'TeXRA',
    icon: '$(symbol-text)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.fixCompilation',
    title: 'Fix LaTeX Compilation Errors',
    category: 'TeXRA',
    icon: '$(wrench)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.getTeXCount',
    title: 'Count Words in Current TeX File',
    category: 'TeXRA',
    icon: '$(symbol-number)',
    enablement: '!virtualWorkspace',
  },
  {
    id: 'texra.countPdfPages',
    title: 'Count PDF Pages',
    category: 'TeXRA',
  },
  {
    id: 'texra.encodeImageToBase64',
    title: 'Encode Image to Base64',
    category: 'TeXRA',
  },
  {
    id: 'texra.convertPdfToImages',
    title: 'Convert PDF to Images',
    category: 'TeXRA',
  },
  {
    id: 'texra.extractFigurePaths',
    title: 'Extract Figure Paths from LaTeX',
    category: 'TeXRA',
  },
  {
    id: 'texra.extractTikzFigures',
    title: 'Extract TikZ Figures from Current File',
    category: 'TeXRA',
  },
  {
    id: 'texra.compileTikzFigures',
    title: 'Compile TikZ Figures from Current File',
    category: 'TeXRA',
  },
  {
    id: 'texra.testConnection',
    title: 'Test API Connection',
    category: 'TeXRA',
  },
  {
    id: 'texra.testAgentLoading',
    title: 'Test Agent Loading',
    category: 'TeXRA',
  },
  {
    id: 'texra.loadSpecificAgent',
    title: 'Load Specific Agent',
    category: 'TeXRA',
  },
  {
    id: 'texra.downloadArXivSource',
    title: 'Download arXiv Source',
    category: 'TeXRA',
  },
  {
    id: 'texra.showImportOptions',
    title: 'Import or Create LaTeX Project',
    category: 'TeXRA',
    icon: '$(cloud-download)',
  },
  {
    id: 'texra.parseXml',
    title: 'Parse XML Structure',
    category: 'TeXRA',
  },
  {
    id: 'texra.parseYaml',
    title: 'Parse YAML Structure',
    category: 'TeXRA',
  },
  {
    id: 'texra.stopAgent',
    title: 'Stop Agent',
    category: 'TeXRA',
  },
  {
    id: 'texra.compactResponse',
    title: 'Compact Response',
    category: 'TeXRA',
  },
  {
    id: 'texra.execute',
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
    title: 'Pack Output into History Folder',
    shortTitle: 'Pack Output',
    category: 'TeXRA',
    icon: '$(archive)',
  },
  {
    id: 'texra.clean',
    title: 'Clean Agent Output Files',
    shortTitle: 'Clean Output',
    category: 'TeXRA',
    icon: '$(trash)',
  },
  {
    id: 'texra.createAgentWithAI',
    title: 'Create AI Agent',
    category: 'TeXRA',
    icon: '$(sparkle)',
  },
  {
    id: 'texra.setApiKey',
    title: 'Set API Key',
    category: 'TeXRA',
  },
  {
    id: 'texra.removeApiKey',
    title: 'Remove API Key',
    category: 'TeXRA',
  },
  {
    id: 'texra.auth.signIn',
    title: 'Sign In',
    category: 'TeXRA',
    icon: '$(sign-in)',
  },
  {
    id: 'texra.auth.signOut',
    title: 'Sign Out',
    category: 'TeXRA',
    icon: '$(sign-out)',
  },
  {
    id: 'texra.auth.viewProfile',
    title: 'View Profile',
    category: 'TeXRA',
    icon: '$(account)',
  },
  {
    id: 'texra.testTextEditor',
    title: 'Test Text Editor Tool',
    category: 'TeXRA',
    icon: '$(edit)',
  },
  {
    id: 'texra.showLinterMessages',
    title: 'Show Linter Messages',
    category: 'TeXRA',
  },
  {
    id: 'texra.countLinterMessages',
    title: 'Count Linter Messages',
    category: 'TeXRA',
  },
  {
    id: 'texra.openDoc',
    title: 'Open TeXRA Documentation',
    category: 'TeXRA',
  },
  {
    id: 'texra.mainView.reset',
    title: 'New Session',
    shortTitle: 'New',
    category: 'TeXRA',
    icon: '$(new-file)',
  },
  {
    id: 'texra.showAgentHistory',
    title: 'Show Agent Execution History',
    category: 'TeXRA',
    icon: '$(history)',
  },
  {
    id: 'texra.showMemory',
    title: 'Show Memory',
    category: 'TeXRA',
    icon: '$(database)',
  },
  {
    id: 'texra.showModels',
    title: 'Show Models',
    category: 'TeXRA',
    icon: '$(hubot)',
  },
  {
    id: 'texra.showAgents',
    title: 'Show Agents',
    category: 'TeXRA',
    icon: '$(symbol-method)',
  },
  {
    id: 'texra.showTools',
    title: 'Show Tool Dashboard',
    category: 'TeXRA',
    icon: '$(tools)',
  },
  {
    id: 'texra.showMultiAgent',
    title: 'Show Multi-Agent Settings',
    category: 'TeXRA',
    icon: '$(organization)',
  },
  {
    id: 'texra.openSettings',
    title: 'Open TeXRA Settings',
    category: 'TeXRA',
    icon: '$(settings-gear)',
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
    title: 'Open Progress in Editor Tab',
    shortTitle: 'Open in Tab',
    category: 'TeXRA',
    icon: '$(multiple-windows)',
  },
  {
    id: 'texra.showDashboard',
    title: 'Show Settings Dashboard',
    shortTitle: 'Settings',
    category: 'TeXRA',
    icon: '$(gear)',
  },
  {
    id: 'texra.showSettingsView',
    title: 'Show Settings',
    category: 'TeXRA',
    icon: '$(gear)',
  },
] as const satisfies readonly CommandCatalogEntry[];

export type CommandId = (typeof commandCatalog)[number]['id'];

export const commandCatalogById = new Map<CommandId, CommandCatalogEntry>(
  commandCatalog.map((entry) => [entry.id, entry]),
);

const commandKeybindingOrder = [
  'texra.showMainView',
  'texra.showProgressView',
  'texra.cleanOutput',
  'texra.cleanBuild',
  'texra.toggleView',
  'texra.execute',
] as const satisfies readonly CommandId[];

function keybindingForCommand(id: CommandId): CommandKeybinding {
  const entry = commandCatalogById.get(id);
  if (!entry || !('keybinding' in entry)) {
    throw new Error(`Command has no keybinding: ${id}`);
  }
  const keybinding = entry.keybinding;
  if (keybinding == null) {
    throw new Error(`Command has no keybinding: ${id}`);
  }
  return keybinding;
}

export const commandKeybindings = commandKeybindingOrder.map((id) => ({
  command: id,
  ...keybindingForCommand(id),
}));
