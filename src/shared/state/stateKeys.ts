/**
 * State storage key enums — vscode-free.
 *
 * Lives in `@shared` so that vscode-free zones (`src/agent/`, `src/latex/`,
 * `src/model/`, `src/tools/`) can name workspace and global state slots via the
 * natural `@shared/state/stateKeys` import path, without any risk of pulling in
 * the VS Code module.
 *
 * These are the harness's keys. An app's keys live beside its rows
 * (`@shared/settingsView/texraSettings`), and a plugin's beside the rows its
 * `Plugin` value declares.
 *
 * The stores these keys address are the session's `roots.workspaceState`,
 * taken as data from the session, tool call or host command that holds it,
 * and the process's `AppState` service (`@platform/interfaces`). Each host
 * wires its own implementation at startup.
 */

export enum WorkspaceStateKey {
  // Agent visibility
  /** Workspace agents selection; the `custom` member carries a category-keyed record. */
  WORKSPACE_AGENTS = 'texra.workspaceAgents',
  CUSTOM_TEAMS = 'texra.customTeams',
  /** Custom agents the user turned off; every other custom agent is shown. */
  HIDDEN_CUSTOM_AGENTS = 'texra.hiddenCustomAgents',

  // Skill availability
  DISABLED_SKILLS = 'texra.skills.disabled',
  DISABLED_SKILL_SOURCES = 'texra.skills.disabledSources',

  // Git commit author settings
  GIT_MARK_COMMITS = 'texra.git.markCommits',
  GIT_AUTHOR_NAME = 'texra.git.authorName',
  GIT_AUTHOR_EMAIL = 'texra.git.authorEmail',

  // Git worktree support
  GIT_WORKTREE_SUPPORT = 'texra.git.worktreeSupport',

  // Tool path safety
  TOOL_PATH_PROTECTION_ENABLED = 'texra.tools.restrictPathsToWorkingDirectory',
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

  /** The per-install key MCP env values are digested under (`mcpConfig`). */
  MCP_REVISION_KEY = 'texra.mcp.revisionKey',

  // Installed Claude Code and Codex plugins, and the trust given to each
  INSTALLED_PLUGINS = 'texra.plugins.installed',

  // Onboarding funnel (user-scoped; see @shared/state/onboardingState)
  /** Canonical shared key; the CLI-originated spelling is intentionally stable. */
  ONBOARDING_DECLINED = 'texra.cli.onboardingDeclined',
  ONBOARDING_FIRST_RUN_DONE = 'texra.onboarding.firstRunDone',
  ONBOARDING_DEFAULT_TEAM_ID = 'texra.onboarding.defaultTeamId',
}

/** Prefix used for per-instruction suppression flags */
export const INSTRUCTION_PREFIX = 'instruction.';
