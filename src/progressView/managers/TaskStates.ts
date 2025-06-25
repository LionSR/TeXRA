// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { objectToTaskState } from '@utils/config';
import { AgentLogger } from '@logger/AgentLogger';
import { TaskState } from '@logger/TaskState';

/**
 * Manages task state per stream with persistence.
 */
export class TaskStates {
  private readonly logger = new AgentLogger('TaskStates');
  private _states: Map<string, TaskState> = new Map();

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    const saved = workspaceSM.get<
      { [key: string]: Record<string, any> } | [string, Record<string, any>][]
    >(this._getWorkspaceKey(WorkspaceStateKey.TASK_STATES));

    if (saved) {
      if (Array.isArray(saved)) {
        this._states = new Map(
          saved.map(([stream, state]) => [stream, objectToTaskState(state)]),
        );
      } else {
        this._states = new Map(
          Object.entries(saved).map(([stream, state]) => [
            stream,
            objectToTaskState(state),
          ]),
        );
      }
    } else {
      this._states.clear();
    }
  }

  save(): void {
    const obj = Object.fromEntries(this._states.entries());
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.TASK_STATES),
      obj,
    );
  }

  get(stream: string): TaskState | undefined {
    return this._states.get(stream);
  }

  set(stream: string, state: TaskState): void {
    this._states.set(stream, state);
  }

  delete(stream: string): void {
    this._states.delete(stream);
  }

  clear(): void {
    this._states.clear();
  }

  entries(): IterableIterator<[string, TaskState]> {
    return this._states.entries();
  }

  keys(): IterableIterator<string> {
    return this._states.keys();
  }

  has(stream: string): boolean {
    return this._states.has(stream);
  }
}
