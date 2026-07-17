/**
 * State storage key enums — vscode-free.
 *
 * Lives in `@shared` so that vscode-free zones (`src/agent/`, `src/latex/`,
 * `src/model/`, `src/tools/`) can name workspace and global state slots via the
 * natural `@shared/state/stateKeys` import path, without any risk of pulling in
 * the VS Code module.
 *
 * The runtime managers (`workspaceSM`, `globalSM`, `initializeStateManagers`)
 * live in `@common/state/stateManager`, which does import `vscode` and must
 * only be touched from VS Code-allowed zones (extension host wiring, command
 * handlers, webview backends). Those zones import from the `@common/state`
 * barrel, which re-exports both these keys and the vscode-coupled managers.
 */

export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
  TASK_GROUPS = 'texra.taskGroups',
  /** Consolidated progress view preferences (replaces individual keys) */
  PROGRESS_VIEW_PREFS = 'texra.progressViewPrefs',

  // Agent visibility (migrated from VS Code config)
  ENABLED_AGENTS = 'texra.enabledAgents',
  ENABLED_TOOL_USE_AGENTS = 'texra.enabledToolUseAgents',
  /** Canonical workspace agent-roster selection. Legacy enabled-agent arrays
   * remain compatibility mirrors and are ignored when this key is present. */
  AGENT_ROSTER_SELECTION = 'texra.agentRosterSelection',
  SUPER_YOLO_ENABLED = 'texra.superYoloEnabled',
  ALLOW_ORCHESTRATOR_KILL = 'texra.allowOrchestratorKill',
  DETACH_SUBAGENTS_ON_STOP = 'texra.detachSubagentsOnStop',
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
  WORKFLOW_REJECT_ON_COMPILE_FAILURE = 'texra.workflow.rejectOnCompileFailure',
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
  /**
   * One-shot per-workspace marker for the legacy global-scope bash-approval
   * override migration. Set after
   * `migrateLegacyGlobalBashApprovalOverride()` runs for this workspace;
   * subsequent activations skip it. See issue #7169.
   */
  BASH_APPROVAL_GLOBAL_MIGRATED = 'texra.bashApprovalGlobalMigrated',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  /** CLI-only bundled-agent sync marker; do not use as an install-age signal. */
  CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION = 'texra.cli.bundledAgents.lastKnownVersion',
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
  STREAMING_KIMI_CODE = 'texra.streaming.kimiCode',
  STREAMING_DASHSCOPE = 'texra.streaming.dashscope',
  STREAMING_MINIMAX = 'texra.streaming.minimax',
  STREAMING_GLM = 'texra.streaming.glm',
  STREAMING_META = 'texra.streaming.meta',

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
  ENDPOINT_META = 'texra.endpoint.meta',

  // Region settings
  DASHSCOPE_USE_CHINA = 'texra.dashscope.useChina',
  MINIMAX_USE_CHINA = 'texra.minimax.useChina',
  GLM_USE_CHINA = 'texra.glm.useChina',
  MOONSHOT_USE_CHINA = 'texra.moonshot.useChina',

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

  // Desktop-only lightweight update check (see desktopUpdateChecker.ts)
  DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT = 'texra.desktop.updateCheck.lastCheckedAt',
  DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION = 'texra.desktop.updateCheck.lastNotifiedVersion',

  // CLI-only lightweight update check throttle (see packages/cli's updateChecker.ts)
  CLI_UPDATE_CHECK_LAST_CHECKED_AT = 'texra.cli.updateCheck.lastCheckedAt',

  // Experimental
  INLINE_CRITICISM_ENABLED = 'texra.inlineCriticism.enabled',

  // Onboarding funnel (user-scoped; see @shared/state/onboardingState)
  /** Legacy key string — predates the shared funnel, kept for CLI compat. */
  ONBOARDING_DECLINED = 'texra.cli.onboardingDeclined',
  ONBOARDING_FIRST_RUN_DONE = 'texra.onboarding.firstRunDone',
  ONBOARDING_DEFAULT_TEAM_ID = 'texra.onboarding.defaultTeamId',
}

/** Prefix used for per-instruction suppression flags */
export const INSTRUCTION_PREFIX = 'instruction.';
