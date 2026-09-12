/**
 * State storage key enums — vscode-free.
 *
 * Lives in `@shared` so that vscode-free zones (`src/agent/`, `src/latex/`,
 * `src/model/`, `src/tools/`) can name workspace and global state slots via the
 * natural `@shared/state/stateKeys` import path, without any risk of pulling in
 * the VS Code module.
 *
 * The stores these keys address are the session's
 * `workspaceRoots().workspaceState` (or the bootstrap-tolerant
 * `tryWorkspaceRoots()`) and the process's `AppState` service
 * (`@platform/interfaces`). Each host wires its own implementation at startup.
 */

export enum WorkspaceStateKey {
  // Agent visibility
  /** Roster selection; the `custom` member carries a category-keyed record. */
  AGENT_ROSTER_SELECTION = 'texra.agentRosterSelection',
  CUSTOM_AGENT_PRESETS = 'texra.customAgentPresets',

  // Skill availability
  DISABLED_SKILLS = 'texra.skills.disabled',
  DISABLED_SKILL_SOURCES = 'texra.skills.disabledSources',

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
  MEMORY_ENABLED = 'texra.memory.enabled',

  // Child-work policy. Global rather than per-workspace: these describe how the
  // user wants their own child runs handled, not anything about a checkout.
  ALLOW_ORCHESTRATOR_KILL = 'texra.allowOrchestratorKill',
  DETACH_SUBAGENTS_ON_STOP = 'texra.detachSubagentsOnStop',

  // Model selection settings
  /** `{ enabledExtras, disabledDefaults }`: the user's delta over `DEFAULT_MODELS`. */
  MODEL_SELECTION = 'texra.modelSelection',
  HELPER_MODEL = 'polishModel',
  REASONING_LEVELS = 'texra.reasoningLevels',
  PREFER_SHORT_MODEL_NAMES = 'texra.preferShortModelNames',

  // Streaming settings
  STREAMING_GLOBAL = 'texra.streaming.global',

  // Agent settings (migrated from VS Code config)
  CUSTOM_AGENT_DIR = 'texra.customAgentDir',

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

  // Dismissable main-view hint. Written only by the banner's own close
  // button, read only to decide whether to show that banner again.
  LOGIN_BANNER_DISMISSED = 'texra.ui.loginBannerDismissed',

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
