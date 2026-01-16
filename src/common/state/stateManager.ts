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
    // Use arguments.length to distinguish between no default and undefined default
    return arguments.length === 1
      ? this.memento.get<T>(key)
      : this.memento.get<T>(key, defaultValue as T);
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
