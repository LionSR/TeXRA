// Local imports - progress view persistence
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';

// Local imports - types
import { TaskGroup } from '@logger/LogTypes';

export interface TaskGroupUpdatePayload {
  stream: StreamTabId;
  groupId: string;
  updates: Partial<TaskGroup>;
}

/**
 * Manages task groups collection with persistence.
 * Handles adding, updating, and managing task groups for different streams.
 */
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  Map<string, TaskGroup>
> {
  private readonly logger: ChannelLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.TASK_GROUPS, 'texra.logGroups');
    this.logger = createChannelLogger('TaskGroupManager');
  }

  /**
   * Add a task group to a stream
   */
  addGroup(stream: StreamTabId, groupId: string, group: TaskGroup): void {
    if (!this.has(stream)) {
      this.items.set(stream, new Map());
    }

    const streamGroups = this.get(stream)!;
    streamGroups.set(groupId, { ...group });
    this.save();
  }

  /**
   * Update an existing task group
   */
  updateGroup({ stream, groupId, updates }: TaskGroupUpdatePayload): void {
    const streamGroups = this.get(stream);
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
    const streamGroups = this.get(stream);
    return streamGroups?.get(groupId);
  }

  /**
   * Get all groups for a stream
   */
  getStreamGroups(stream: StreamTabId): Map<string, TaskGroup> {
    return this.get(stream) || new Map();
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
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const entries = Object.entries(
      data as Record<string, (TaskGroup & { id?: string }) | undefined>,
    );
    const groups = new Map<string, TaskGroup>();

    for (const [key, value] of entries) {
      if (!value) {
        continue;
      }

      const group: TaskGroup = {
        ...value,
        id: value.id ?? key,
      } as TaskGroup;
      groups.set(key, group);
    }

    return groups;
  }
}
