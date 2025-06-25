// Third-party imports

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { BaseStateManager } from './BaseStateManager';

// Types
import type { TaskGroup } from '../../logger/LogTypes';

/**
 * Manages task group information for log streams.
 */
export class GroupsManager extends BaseStateManager {
  public readonly map: Map<string, Map<string, TaskGroup>> = new Map();
  private readonly logger = new AgentLogger('GroupsManager');

  async load(): Promise<void> {
    let savedGroups = workspaceSM.get<{
      [key: string]: { [groupId: string]: TaskGroup };
    }>(this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS));

    if (!savedGroups) {
      const oldGroups = workspaceSM.get<{
        [key: string]: { [groupId: string]: TaskGroup };
      }>(this._getWorkspaceKey('texra.logGroups'));
      if (oldGroups) {
        savedGroups = oldGroups;
        await workspaceSM.update(
          this._getWorkspaceKey('texra.logGroups'),
          undefined,
        );
        this.logger.debug('Migrated log groups to task groups');
      }
    }

    if (savedGroups) {
      this.map.clear();
      for (const [streamId, groups] of Object.entries(savedGroups)) {
        if (shouldUseConsolidatedChannel(streamId)) {
          continue;
        }
        const groupMap = new Map<string, TaskGroup>();
        for (const [id, g] of Object.entries(groups)) {
          groupMap.set(id, {
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
          });
        }
        this.map.set(streamId, groupMap);
      }
    } else {
      this.map.clear();
    }
  }

  save(): void {
    const persistent = Array.from(this.map.entries())
      .filter(([channel]) => !shouldUseConsolidatedChannel(channel))
      .map(([streamId, groups]) => [
        streamId,
        Object.fromEntries(groups.entries()),
      ]);
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS),
      Object.fromEntries(persistent),
    );
  }

  clear(stream: string): void {
    this.map.delete(stream);
  }

  clearAll(): void {
    this.map.clear();
  }
}
