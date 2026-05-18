/**
 * State storage keys — vscode-free.
 *
 * These enums are pure data (string constants) so vscode-free zones such as
 * `src/agent/`, `src/latex/`, `src/model/`, `src/tools/` can name workspace
 * and global state slots without pulling in the VS Code module. The runtime
 * managers (`workspaceSM`, `globalSM`, `initializeStateManagers`) live in
 * `stateManager.ts`, which does import `vscode` and therefore must only be
 * touched from VS Code-allowed zones (extension host wiring, command handlers,
 * webview backends).
 *
 * Vscode-free consumers should import from `@common/state/stateKeys` directly,
 * not from the `@common/state` barrel — the barrel re-exports the runtime
 * managers and would re-couple the importer to vscode at module-load time.
 */

export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
  STREAM_LOGS = 'texra.streamLogs',
  STREAM_TABS = 'texra.streamTabs',
  TASK_GROUPS = 'texra.taskGroups',
  OUTPUT_FILES = 'texra.outputFiles',
  MISSING_OUTPUTS = 'texra.missingOutputs',
  RUN_INSTRUCTIONS = 'texra.runInstructions',
  ACTIVE_RUN_IDS = 'texra.activeRunIds',
  TASK_STATES = 'texra.taskStates',
  EXECUTION_IDS = 'texra.executionIds',
  USAGE_STATS = 'texra.usageStats',
  /** Consolidated progress view preferences (replaces individual keys) */
  PROGRESS_VIEW_PREFS = 'texra.progressViewPrefs',

  // Agent visibility (migrated from VS Code config)
  ENABLED_AGENTS = 'texra.enabledAgents',
  ENABLED_TOOL_USE_AGENTS = 'texra.enabledToolUseAgents',
  PARENT_STREAM_IDS = 'texra.parentStreamIds',
  SUPER_YOLO_ENABLED = 'texra.superYoloEnabled',
  ALLOW_ORCHESTRATOR_KILL = 'texra.allowOrchestratorKill',
  DETACH_SUBAGENTS_ON_STOP = 'texra.detachSubagentsOnStop',
  NESTED_DELEGATION_MAX_DEPTH = 'texra.nestedDelegationMaxDepth',
  CUSTOM_AGENT_PRESETS = 'texra.customAgentPresets',

  // Codex settings
  CODEX_SANDBOX_MODE = 'texra.codexSandboxMode',
  CODEX_REASONING_EFFORT = 'texra.codexReasoningEffort',
  CODEX_APPROVAL_POLICY = 'texra.codexApprovalPolicy',

  // Claude Code CLI settings
  CLAUDE_AGENT_MODEL = 'texra.claudeAgentModel',
  CLAUDE_AGENT_PERMISSION_MODE = 'texra.claudeAgentPermissionMode',
  CLAUDE_AGENT_EFFORT = 'texra.claudeAgentEffort',

  // Git commit author settings
  GIT_MARK_COMMITS = 'texra.git.markCommits',
  GIT_AUTHOR_NAME = 'texra.git.authorName',
  GIT_AUTHOR_EMAIL = 'texra.git.authorEmail',

  // Git worktree support
  GIT_WORKTREE_SUPPORT = 'texra.git.worktreeSupport',

  // LaTeX/compile/diff settings (migrated from VS Code config)
  WORKFLOW_AUTO_COMPILE = 'texra.workflow.autoCompileAfterOutput',
  WORKFLOW_AUTO_COMPILE_TIMEOUT_MS = 'texra.workflow.autoCompileTimeoutMs',
  WORKFLOW_AUTO_OPEN_PDF = 'texra.workflow.autoOpenPdf',
  LATEXDIFF_BETWEEN_ROUNDS = 'texra.latexdiff.generateBetweenRoundDiffs',
  LATEXDIFF_TIMEOUT_MS = 'texra.latexdiff.timeoutMs',
  LATEXDIFF_MATH_MARKUP = 'texra.latexdiff.mathMarkup',
  LATEXDIFF_CHANGES_ONLY = 'texra.latexdiff.changesOnly',
  LATEX_FORMATTER = 'texra.latex.formatter',
  /**
   * One-shot per-workspace marker for the legacy `texra.*` config migration.
   * Set after `migrateLatexConfigToStorage()` runs; subsequent activations
   * skip the migration entirely. This is what distinguishes "key never
   * migrated" (no marker) from "user explicitly reset via UI" (marker set,
   * key absent) so reset-to-default isn't silently undone on next start.
   */
  LATEX_SETTINGS_MIGRATED = 'texra.latexSettingsMigrated',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  MODEL_LIST_VERSION = 'modelListVersion',
  MEMORY_ENABLED = 'texra.memory.enabled',

  // Model selection settings
  ENABLED_MODELS = 'enabledModels',
  HELPER_MODEL = 'polishModel',
  REASONING_LEVELS = 'texra.reasoningLevels',
  PREFER_SHORT_MODEL_NAMES = 'texra.preferShortModelNames',

  // Streaming settings
  STREAMING_GLOBAL = 'texra.streaming.global',
  STREAMING_OPENAI = 'texra.streaming.openai',
  STREAMING_ANTHROPIC = 'texra.streaming.anthropic',
  STREAMING_OPENROUTER = 'texra.streaming.openrouter',
  STREAMING_GOOGLE = 'texra.streaming.google',
  STREAMING_XAI = 'texra.streaming.xai',
  STREAMING_DEEPSEEK = 'texra.streaming.deepseek',
  STREAMING_MOONSHOT = 'texra.streaming.moonshot',
  STREAMING_DASHSCOPE = 'texra.streaming.dashscope',
  STREAMING_MINIMAX = 'texra.streaming.minimax',
  STREAMING_GLM = 'texra.streaming.glm',

  // LaTeX settings
  LATEX_CONFIG_VERSION = 'texra.latexConfigVersion',

  // Agent settings (migrated from VS Code config)
  CUSTOM_AGENT_DIR = 'texra.customAgentDir',
  REMOTE_AGENT_META_CACHE = 'texra.remoteAgentMetaCache',

  // Anthropic API settings
  ANTHROPIC_DYNAMIC_FILTERING = 'texra.anthropic.dynamicFiltering',

  // Endpoint settings
  ENDPOINT_OPENAI = 'texra.endpoint.openai',
  ENDPOINT_ANTHROPIC = 'texra.endpoint.anthropic',
  ENDPOINT_GOOGLE = 'texra.endpoint.google',
  ENDPOINT_DEEPSEEK = 'texra.endpoint.deepseek',
  ENDPOINT_XAI = 'texra.endpoint.xai',
  ENDPOINT_MOONSHOT = 'texra.endpoint.moonshot',
  ENDPOINT_DASHSCOPE = 'texra.endpoint.dashscope',
  ENDPOINT_MINIMAX = 'texra.endpoint.minimax',
  ENDPOINT_GLM = 'texra.endpoint.glm',

  // Region settings
  DASHSCOPE_USE_CHINA = 'texra.dashscope.useChina',
  MINIMAX_USE_CHINA = 'texra.minimax.useChina',
  GLM_USE_CHINA = 'texra.glm.useChina',

  // Coding plan settings
  GLM_CODING_PLAN = 'texra.glm.codingPlan',

  // Routing settings
  USE_OPENROUTER = 'texra.useOpenRouter',

  // Transport settings
  WEBSOCKET_OPENAI = 'texra.websocket.openai',

  // Tool settings
  DISABLED_TOOLS = 'texra.tools.disabled',

  // Desktop-only crash reporting
  DESKTOP_CRASH_REPORTING_ENABLED = 'texra.desktop.crashReporting.enabled',

  // Experimental
  INLINE_CRITICISM_ENABLED = 'texra.inlineCriticism.enabled',
}

/** Prefix used for per-instruction suppression flags */
export const INSTRUCTION_PREFIX = 'instruction.';
