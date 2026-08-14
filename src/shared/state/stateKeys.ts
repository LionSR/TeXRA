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
  /** Consolidated progress-view preferences. */
  PROGRESS_VIEW_PREFS = 'texra.progressViewPrefs',

  // Agent visibility
  /** Roster selection; the `custom` member carries a category-keyed record. */
  AGENT_ROSTER_SELECTION = 'texra.agentRosterSelection',
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

  // Tool path safety
  TOOL_PATH_PROTECTION_ENABLED = 'texra.tools.restrictPathsToWorkingDirectory',

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
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  /**
   * CLI-only bundled-agent sync marker.
   *
   * This is not a cross-host install-age signal. Before the CLI's first
   * bundled-agent sync, startup seeding may combine its absence with an absent
   * `DISABLED_TOOLS` value to recognize a fresh CLI profile.
   */
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

  // Agent settings (migrated from VS Code config)
  CUSTOM_AGENT_DIR = 'texra.customAgentDir',
  REMOTE_AGENT_META_CACHE = 'texra.remoteAgentMetaCache',

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
  KIMI_CODE_PREFER = 'texra.kimiCode.prefer',

  // Routing settings
  USE_OPENROUTER = 'texra.useOpenRouter',
  /** Canonical base model ids the user prefers to serve through Copilot. */
  COPILOT_ROUTE_MODELS = 'texra.copilotRouteModels',

  // Transport settings
  WEBSOCKET_OPENAI = 'texra.websocket.openai',

  // Tool settings
  DISABLED_TOOLS = 'texra.tools.disabled',

  // Desktop-only lightweight update check (see desktopUpdateChecker.ts)
  DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT = 'texra.desktop.updateCheck.lastCheckedAt',
  DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION = 'texra.desktop.updateCheck.lastNotifiedVersion',

  // CLI-only lightweight update check throttle (see packages/cli's updateChecker.ts)
  CLI_UPDATE_CHECK_LAST_CHECKED_AT = 'texra.cli.updateCheck.lastCheckedAt',

  // Dismissable main-view hints. Written only by the banner's own close
  // button, read only to decide whether to show that banner again.
  LOGIN_BANNER_DISMISSED = 'texra.ui.loginBannerDismissed',
  ORCHESTRATOR_BANNER_DISMISSED = 'texra.ui.orchestratorBannerDismissed',

  // Experimental
  INLINE_CRITICISM_ENABLED = 'texra.inlineCriticism.enabled',

  // Onboarding funnel (user-scoped; see @shared/state/onboardingState)
  /** Canonical shared key; the CLI-originated spelling is intentionally stable. */
  ONBOARDING_DECLINED = 'texra.cli.onboardingDeclined',
  ONBOARDING_FIRST_RUN_DONE = 'texra.onboarding.firstRunDone',
  ONBOARDING_DEFAULT_TEAM_ID = 'texra.onboarding.defaultTeamId',
}

/** Prefix used for per-instruction suppression flags */
export const INSTRUCTION_PREFIX = 'instruction.';
