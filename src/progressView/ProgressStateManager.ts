// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { objectToTaskState } from '@utils/config';
import { TaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';
import {
  StreamsManager,
  GroupsManager,
  FilesManager,
  UsageManager,
} from './state';

// Types

/**
 * Manages persistence of progress view state to workspace storage.
 * Handles loading and saving of log streams, groups, output files,
 * task states, and usage statistics.
 */
export class ProgressStateManager {
  private readonly logger: AgentLogger;

  // State collections
  public readonly streams = new StreamsManager();
  public readonly groups = new GroupsManager();
  public readonly files = new FilesManager();
  public readonly usage = new UsageManager();
  private _taskStates: Map<string, TaskState> = new Map();

  constructor() {
    this.logger = new AgentLogger('ProgressStateManager');
  }

  // Getters for task state collection
  get taskStates(): Map<string, TaskState> {
    return this._taskStates;
  }

  get activeStream(): string {
    return this.streams.active;
  }

  set activeStream(stream: string) {
    this.streams.active = stream;
  }

  /**
   * Load all state from workspace storage
   */
  public async loadState(): Promise<void> {
    await this.streams.load();
    await this.groups.load();
    await this.files.load();
    await this._loadTaskStates();
    await this.usage.load();
  }

  /**
   * Save all state to workspace storage
   */
  public saveState(): void {
    this.streams.save();
    this.groups.save();
    this.files.save();
    this._saveTaskStates();
    this.usage.save();
  }

  /**
   * Load task states
   */
  private async _loadTaskStates(): Promise<void> {
    const savedTaskStates = workspaceSM.get<
      { [key: string]: Record<string, any> } | [string, Record<string, any>][]
    >(WorkspaceStateKey.TASK_STATES);

    if (savedTaskStates) {
      if (Array.isArray(savedTaskStates)) {
        // Backwards compatibility: convert from array format if encountered
        this._taskStates = new Map(
          savedTaskStates.map(([stream, state]) => [
            stream,
            objectToTaskState(state),
          ]),
        );
      } else {
        this._taskStates = new Map(
          Object.entries(savedTaskStates).map(([stream, state]) => [
            stream,
            objectToTaskState(state),
          ]),
        );
      }
    } else {
      this._taskStates.clear();
    }
  }

  /**
   * Save task states
   */
  private _saveTaskStates(): void {
    const taskStatesObj = Object.fromEntries(this._taskStates.entries());
    workspaceSM.update(WorkspaceStateKey.TASK_STATES, taskStatesObj);
  }

  /**
   * Clear all state for a specific stream
   */
  public clearStream(stream: string): void {
    this.streams.clear(stream);
    this.groups.clear(stream);
    this.files.clear(stream);
    this._taskStates.delete(stream);
    this.usage.clear(stream);
  }

  /**
   * Clear all state
   */
  public clearAll(): void {
    this.streams.clearAll();
    this.groups.clearAll();
    this.files.clearAll();
    this._taskStates.clear();
    this.usage.clearAll();
  }
}
