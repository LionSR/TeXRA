// Third-party imports
import * as vscode from 'vscode';

// Simple enums for commonly used state keys
export enum WorkspaceStateKey {
  AGENT_HISTORY = 'texra.agentHistory',
  LOG_STREAMS = 'texra.logStreams',
  LOG_GROUPS = 'texra.logGroups',
  OUTPUT_FILES = 'texra.outputFiles',
  ACTIVE_LOG_STREAM = 'texra.activeLogStream',
  TASK_STATES = 'texra.taskStates',
  USAGE_STATS = 'texra.usageStats',
}

export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
}

// Prefix used for per-instruction suppression flags
export const INSTRUCTION_PREFIX = 'instruction.';

/**
 * Centralized helper for accessing VS Code workspace and global state.
 * Must be initialized with the extension context before use.
 */
export class StateManager {
  private static workspace: vscode.Memento;
  private static global: vscode.Memento;

  public static initialize(context: vscode.ExtensionContext): void {
    this.workspace = context.workspaceState;
    this.global = context.globalState;
  }

  public static getWorkspaceValue<T>(
    key: WorkspaceStateKey | string,
  ): T | undefined;
  public static getWorkspaceValue<T>(
    key: WorkspaceStateKey | string,
    defaultValue: T,
  ): T;
  public static getWorkspaceValue<T>(
    key: WorkspaceStateKey | string,
    defaultValue?: T,
  ): T | undefined {
    // VS Code's Memento.get has the same overload pattern
    // When no default is provided, it returns T | undefined
    // When a default is provided, it returns T
    if (arguments.length === 1) {
      return this.workspace.get<T>(key);
    }
    return this.workspace.get<T>(key, defaultValue!);
  }

  public static updateWorkspaceValue<T>(
    key: WorkspaceStateKey | string,
    value: T,
  ): Thenable<void> {
    return this.workspace.update(key, value);
  }

  public static getGlobalValue<T>(
    key: GlobalStateKey | string,
  ): T | undefined;
  public static getGlobalValue<T>(
    key: GlobalStateKey | string,
    defaultValue: T,
  ): T;
  public static getGlobalValue<T>(
    key: GlobalStateKey | string,
    defaultValue?: T,
  ): T | undefined {
    // VS Code's Memento.get has the same overload pattern
    // When no default is provided, it returns T | undefined
    // When a default is provided, it returns T
    if (arguments.length === 1) {
      return this.global.get<T>(key);
    }
    return this.global.get<T>(key, defaultValue!);
  }

  public static updateGlobalValue<T>(
    key: GlobalStateKey | string,
    value: T,
  ): Thenable<void> {
    return this.global.update(key, value);
  }
}
