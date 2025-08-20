// Local imports - progress view
// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import { TaskGroup } from '@logger/LogTypes';

/**
 * Manages task groups collection with persistence.
 * Handles adding, updating, and managing task groups for different streams.
 */
export class TaskGroupManager {
  private _groups: Map<StreamTabId, Map<string, TaskGroup>> = new Map();
  private readonly logger: AgentLogger;

  constructor(private persistence: StatePersistenceManager) {
    this.logger = new AgentLogger('TaskGroupManager');
  }

  /**
   * Add a task group to a stream
   */
  addGroup(stream: StreamTabId, groupId: string, group: TaskGroup): void {
    if (!this._groups.has(stream)) {
      this._groups.set(stream, new Map());
    }

    const streamGroups = this._groups.get(stream)!;
    streamGroups.set(groupId, { ...group });
    this.save();
  }

  /**
   * Update an existing task group
   */
  updateGroup(
    stream: StreamTabId,
    groupId: string,
    updates: Partial<TaskGroup>,
  ): void {
    const streamGroups = this._groups.get(stream);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot update group ${groupId}: stream ${stream} not found`,
      );
      return;
    }

    const group = streamGroups.get(groupId);
    if (!group) {
      this.logger.warn(
        `Cannot update group ${groupId}: group not found in stream ${stream}`,
      );
      return;
    }

    // Apply updates
    Object.assign(group, updates);
    streamGroups.set(groupId, group);
    this.save();
  }

  /**
   * Get a specific task group
   */
  getGroup(stream: StreamTabId, groupId: string): TaskGroup | undefined {
    const streamGroups = this._groups.get(stream);
    return streamGroups?.get(groupId);
  }

  /**
   * Get all groups for a stream
   */
  getStreamGroups(stream: StreamTabId): Map<string, TaskGroup> {
    return this._groups.get(stream) || new Map();
  }

  /**
   * Get all groups across all streams
   */
  getAll(): Map<StreamTabId, Map<string, TaskGroup>> {
    return new Map(this._groups);
  }

  /**
   * Check if a stream has groups
   */
  hasStream(stream: StreamTabId): boolean {
    return this._groups.has(stream);
  }

  /**
   * Delete all groups for a stream
   */
  deleteStream(stream: StreamTabId): void {
    this._groups.delete(stream);
    this.save();
  }

  /**
   * Clear all groups
   */
  clear(): void {
    this._groups.clear();
    this.save();
  }

  /**
   * Set all groups (used during loading)
   */
  setAll(groups: Map<StreamTabId, Map<string, TaskGroup>>): void {
    this._groups = new Map(groups);
  }

  /**
   * Load task groups from persistence
   */
  async load(): Promise<void> {
    const savedGroups = await this.persistence.loadWithMigration<{
      [key: string]: { [groupId: string]: TaskGroup };
    }>(WorkspaceStateKey.TASK_GROUPS, 'texra.logGroups', {});

    if (savedGroups && Object.keys(savedGroups).length > 0) {
      const processedGroups = new Map<StreamTabId, Map<string, TaskGroup>>();

      for (const [streamId, groups] of Object.entries(savedGroups)) {
        const streamGroupsMap = new Map<string, TaskGroup>();

        for (const [id, group] of Object.entries(groups)) {
          // Normalize timestamp fields
          const normalizedGroup: TaskGroup = {
            ...group,
            startTime:
              typeof group.startTime === 'string'
                ? new Date(group.startTime).getTime()
                : group.startTime,
            endTime:
              group.endTime !== undefined
                ? typeof group.endTime === 'string'
                  ? new Date(group.endTime).getTime()
                  : group.endTime
                : undefined,
          };

          streamGroupsMap.set(id, normalizedGroup);
        }

        processedGroups.set(streamId, streamGroupsMap);
      }

      this._groups = processedGroups;
      this.logger.debug(`Loaded task groups for ${this._groups.size} streams`);
    } else {
      this._groups.clear();
    }
  }

  /**
   * Save task groups to persistence
   */
  save(): void {
    const persistentGroups = Array.from(this._groups.entries()).map(
      ([streamId, groups]) => [streamId, Object.fromEntries(groups.entries())],
    );
    const groupsObj = Object.fromEntries(persistentGroups);
    this.persistence.save(WorkspaceStateKey.TASK_GROUPS, groupsObj);
  }
}
