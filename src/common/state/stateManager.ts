// Third-party imports
import * as vscode from 'vscode';

// Simple enums for commonly used state keys
export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
  STREAM_TABS = 'texra.streamTabs',
  TASK_GROUPS = 'texra.taskGroups',
  OUTPUT_FILES = 'texra.outputFiles',
  MISSING_OUTPUTS = 'texra.missingOutputs',
  ACTIVE_STREAM_TAB = 'texra.activeStreamTab',
  TASK_STATES = 'texra.taskStates',
  TASK_IDS = 'texra.taskIds', // Legacy key for migration
  EXECUTION_IDS = 'texra.executionIds',
  USAGE_STATS = 'texra.usageStats',
  STREAM_SORT_ORDER = 'texra.streamSortOrder',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  LATEX_WORKSHOP_PROMPTED = 'latexWorkshopPrompted',
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
