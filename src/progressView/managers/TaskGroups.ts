// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { TaskGroup } from '../../logger/LogTypes';

/**
 * Manages task groups per stream with persistence.
 */
export class TaskGroups {
  private readonly logger = new AgentLogger('TaskGroups');
  private _groups: Map<string, Map<string, TaskGroup>> = new Map();

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    let saved = workspaceSM.get<{
      [key: string]: { [groupId: string]: TaskGroup };
    }>(this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS));

    if (!saved) {
      const old = workspaceSM.get<{
        [key: string]: { [groupId: string]: TaskGroup };
      }>(this._getWorkspaceKey('texra.logGroups'));
      if (old) {
        saved = old;
        await workspaceSM.update(
          this._getWorkspaceKey('texra.logGroups'),
          undefined,
        );
        this.logger.debug('Migrated log groups to task groups');
      }
    }

    if (saved) {
      this._groups = new Map(
        Object.entries(saved)
          .filter(([channel]) => !shouldUseConsolidatedChannel(channel))
          .map(([streamId, groups]) => [
            streamId,
            new Map(
              Object.entries(groups).map(([id, g]) => [
                id,
                {
                  ...g,
                  startTime:
                    typeof g.startTime === 'string'
                      ? new Date(g.startTime).getTime()
                      : g.startTime,
                  endTime:
                    g.endTime !== undefined
                      ? typeof g.endTime === 'string'
                        ? new Date(g.endTime).getTime()
                        : g.endTime
                      : undefined,
                },
              ]),
            ),
          ]),
      );
    } else {
      this._groups.clear();
    }
  }

  save(): void {
    const persistent = Array.from(this._groups.entries())
      .filter(([channel]) => !shouldUseConsolidatedChannel(channel))
      .map(([streamId, groups]) => [
        streamId,
        Object.fromEntries(groups.entries()),
      ]);
    const obj = Object.fromEntries(persistent);
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS),
      obj,
    );
  }

  get(stream: string): Map<string, TaskGroup> | undefined {
    return this._groups.get(stream);
  }

  set(stream: string, groups: Map<string, TaskGroup>): void {
    this._groups.set(stream, groups);
  }

  delete(stream: string): void {
    this._groups.delete(stream);
  }

  clear(): void {
    this._groups.clear();
  }

  entries(): IterableIterator<[string, Map<string, TaskGroup>]> {
    return this._groups.entries();
  }

  keys(): IterableIterator<string> {
    return this._groups.keys();
  }

  has(stream: string): boolean {
    return this._groups.has(stream);
  }
}
