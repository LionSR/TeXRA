// Third-party imports
import * as vscode from 'vscode';

// Simple enums for commonly used state keys
export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
  STREAM_TABS = 'texra.streamTabs',
  TASK_GROUPS = 'texra.taskGroups',
  OUTPUT_FILES = 'texra.outputFiles',
  MISSING_OUTPUTS = 'texra.missingOutputs',
  RUN_INSTRUCTIONS = 'texra.runInstructions',
  ACTIVE_RUN_IDS = 'texra.activeRunIds',
  ACTIVE_STREAM_TAB = 'texra.activeStreamTab',
  TASK_STATES = 'texra.taskStates',
  EXECUTION_IDS = 'texra.executionIds',
  USAGE_STATS = 'texra.usageStats',
  STREAM_SORT_ORDER = 'texra.streamSortOrder',
  STREAM_AGENT_FILTER = 'texra.streamAgentFilter',

  // Settings (migrated from package.json config to storage)
  STORAGE_MODE = 'texra.settings.storageMode',
  SESSION_RETENTION = 'texra.settings.sessionRetention',
  MAX_RETRY_ATTEMPTS = 'texra.settings.maxRetryAttempts',
  RETRY_BACKOFF_MS = 'texra.settings.retryBackoffMs',
  FORMATTER = 'texra.settings.formatter',
  MATH_MARKUP = 'texra.settings.mathMarkup',
  PERSIST_SESSIONS = 'texra.settings.persistSessions',
  COMPACTION_THRESHOLD = 'texra.settings.compactionThreshold',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  MODEL_LIST_VERSION = 'modelListVersion',
  MEMORY_ENABLED = 'texra.memory.enabled',
}

// Prefix used for per-instruction suppression flags
export const INSTRUCTION_PREFIX = 'instruction.';

/**
 * State manager class that wraps VS Code's Memento
 */
class StateManagerImpl {
  constructor(private memento: vscode.Memento) {}

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (arguments.length === 1) {
      return this.memento.get<T>(key);
    }
    return this.memento.get<T>(key, defaultValue!);
  }

  update<T>(key: string, value: T): Thenable<void> {
    return this.memento.update(key, value);
  }
}

// Export the state managers that will be initialized
export let workspaceSM: StateManagerImpl;
export let globalSM: StateManagerImpl;

/**
 * Initialize the state managers with the extension context
 */
export function initializeStateManagers(
  context: vscode.ExtensionContext,
): void {
  workspaceSM = new StateManagerImpl(context.workspaceState);
  globalSM = new StateManagerImpl(context.globalState);
}
