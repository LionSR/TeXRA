// Third-party imports
import * as vscode from 'vscode';

export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
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
  // Legacy keys (kept for reference, no longer used):
  // ACTIVE_STREAM_TAB = 'texra.activeStreamTab',
  // STREAM_SORT_ORDER = 'texra.streamSortOrder',
  // STREAM_AGENT_FILTER = 'texra.streamAgentFilter',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  MODEL_LIST_VERSION = 'modelListVersion',
  MEMORY_ENABLED = 'texra.memory.enabled',

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

  // Endpoint settings
  ENDPOINT_OPENAI = 'texra.endpoint.openai',
  ENDPOINT_ANTHROPIC = 'texra.endpoint.anthropic',
  ENDPOINT_GOOGLE = 'texra.endpoint.google',
  ENDPOINT_DEEPSEEK = 'texra.endpoint.deepseek',
  ENDPOINT_XAI = 'texra.endpoint.xai',
  ENDPOINT_MOONSHOT = 'texra.endpoint.moonshot',
  ENDPOINT_DASHSCOPE = 'texra.endpoint.dashscope',
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
