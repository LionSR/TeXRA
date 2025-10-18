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
      };

      if (group.instruction && typeof group.instruction.text === 'string') {
        const metadata = group.instruction.metadata;
        const normalizedMetadata =
          metadata && typeof metadata === 'object'
            ? {
                ...(typeof metadata.showToggle === 'boolean'
                  ? { showToggle: metadata.showToggle }
                  : {}),
                ...(typeof metadata.expanded === 'boolean'
                  ? { expanded: metadata.expanded }
                  : {}),
              }
            : undefined;

        normalized.instruction = {
          text: group.instruction.text,
          ...(normalizedMetadata && Object.keys(normalizedMetadata).length > 0
            ? { metadata: normalizedMetadata }
            : {}),
        };
      }

      map.set(id, normalized);
    }
    return map;
  }
}
