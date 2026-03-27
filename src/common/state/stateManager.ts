// Third-party imports
import * as vscode from 'vscode';

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
  CUSTOM_AGENT_PRESETS = 'texra.customAgentPresets',

  // Git commit author settings
  GIT_MARK_COMMITS = 'texra.git.markCommits',
  GIT_AUTHOR_NAME = 'texra.git.authorName',
  GIT_AUTHOR_EMAIL = 'texra.git.authorEmail',
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
}

/** Prefix used for per-instruction suppression flags */
export const INSTRUCTION_PREFIX = 'instruction.';

/** Workspace state manager (initialized via initializeStateManagers) */
export let workspaceSM: vscode.Memento;

/** Global state manager (initialized via initializeStateManagers) */
export let globalSM: vscode.Memento;

/** Initialize the state managers with the extension context */
export function initializeStateManagers(
  context: vscode.ExtensionContext,
): void {
  workspaceSM = context.workspaceState;
  globalSM = context.globalState;
}
