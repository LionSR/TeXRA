// Local imports - progress view
// Local imports
import { PersistentMapManager } from '../persistence/PersistentMapManager';
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
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  Map<string, TaskGroup>
> {
  private readonly logger: AgentLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.TASK_GROUPS, 'texra.logGroups');
    this.logger = new AgentLogger('TaskGroupManager');
  }

  /**
   * Add a task group to a stream
   */
  addGroup(stream: StreamTabId, groupId: string, group: TaskGroup): void {
    if (!this.has(stream)) {
      this.items.set(stream, new Map());
    }

    const streamGroups = this.get(stream)!;
    const existing = streamGroups.get(groupId);
    const merged: TaskGroup = {
      ...group,
      instruction: group.instruction ?? existing?.instruction,
    };
    streamGroups.set(groupId, merged);
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
    const streamGroups = this.get(stream);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot update group ${groupId}: stream ${stream} not found`,
      );
      return;
    }

    let group = streamGroups.get(groupId);
    if (!group) {
      this.logger.warn(
        `Group ${groupId} not found in stream ${stream}, creating placeholder`,
      );
      group = {
        id: groupId,
        name: updates.name ?? groupId,
        startTime: updates.startTime ?? Date.now(),
        status: updates.status ?? 'running',
        parentGroupId: updates.parentGroupId,
        usage: updates.usage,
      };
      if (updates.instruction !== undefined) {
        group.instruction = updates.instruction;
      }
    } else {
      const { instruction, ...rest } = updates;
      Object.assign(group, rest);
      if (instruction !== undefined) {
        group.instruction = instruction;
      }
    }

    streamGroups.set(groupId, group);
    this.save();
  }

  /**
   * Get a specific task group
   */
  getGroup(stream: StreamTabId, groupId: string): TaskGroup | undefined {
    const streamGroups = this.get(stream);
    return streamGroups?.get(groupId);
  }

  /**
   * Get all groups for a stream
   */
  getStreamGroups(stream: StreamTabId): Map<string, TaskGroup> {
    const streamGroups = this.get(stream);
    return streamGroups ? new Map(streamGroups) : new Map();
  }

  /**
   * Get all groups for a stream as an array
   */
  getGroupsForStream(stream: StreamTabId): TaskGroup[] {
    const streamGroups = this.get(stream);
    return streamGroups ? Array.from(streamGroups.values()) : [];
  }

  /**
   * Delete a specific group from a stream
   */
  deleteGroup(stream: StreamTabId, groupId: string): void {
    const streamGroups = this.get(stream);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot delete group ${groupId}: stream ${stream} not found`,
      );
      return;
    }

    // First, find and delete all child groups recursively
    const deleteChildren = (parentId: string) => {
      const children = Array.from(streamGroups.values()).filter(
        (g) => g.parentGroupId === parentId,
      );
      children.forEach((child) => {
        deleteChildren(child.id);
        streamGroups.delete(child.id);
      });
    };

    deleteChildren(groupId);

    // Then delete the group itself
    const deleted = streamGroups.delete(groupId);
    if (deleted) {
      this.save();
      this.logger.debug(`Deleted group ${groupId} from stream ${stream}`);
    } else {
      this.logger.warn(`Group ${groupId} not found in stream ${stream}`);
    }
  }

  /**
   * Check if a stream has groups
   */
  hasStream(stream: StreamTabId): boolean {
    return this.has(stream);
  }

  /**
   * Delete all groups for a stream
   */
  deleteStream(stream: StreamTabId): void {
    this.delete(stream);
  }

  /**
   * Clear all groups
   */
  clear(): void {
    super.clear();
  }

  /**
   * Set all groups (used during loading)
   */
  setAll(groups: Map<StreamTabId, Map<string, TaskGroup>>): void {
    super.setAll(groups);
  }

  /**
   * Load task groups from persistence
   */
  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      this.logger.debug(`Loaded task groups for ${this.items.size} streams`);
    }
  }

  /** Convert groups map to plain object */
  protected override serialize(
    value: Map<string, TaskGroup>,
    _key: StreamTabId,
  ): unknown {
    return Object.fromEntries(value.entries());
  }

  /** Normalize loaded groups */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<Map<string, TaskGroup>> {
    const groups = data as Record<string, TaskGroup>;
    const map = new Map<string, TaskGroup>();
    for (const [id, group] of Object.entries(groups)) {
      const normalized: TaskGroup = {
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
        instruction: group.instruction
          ? {
              ...group.instruction,
              updatedAt:
                typeof group.instruction.updatedAt === 'string'
                  ? new Date(group.instruction.updatedAt).getTime()
                  : group.instruction.updatedAt,
            }
          : undefined,
      };
      map.set(id, normalized);
    }
    return map;
  }
}
