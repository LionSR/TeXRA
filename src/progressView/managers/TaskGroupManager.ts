// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import {
  WorkspaceStateKey,
  type StateManager,
} from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

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
export class TaskGroupManager {
  private readonly logger: AgentLogger;
  private readonly store: StateManager;
  private items = new Map<StreamTabId, Map<string, TaskGroup>>();

  constructor(store: StateManager) {
    this.store = store;
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
    this.persist();
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
    this.persist();
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
    if (this.items.delete(stream)) {
      this.persist();
    }
  }

  /**
   * Clear all groups
   */
  clear(): void {
    if (this.items.size === 0) {
      return;
    }
    this.items.clear();
    this.persist();
  }

  /**
   * Set all groups (used during loading)
   */
  setAll(groups: Map<StreamTabId, Map<string, TaskGroup>>): void {
    this.items = new Map(groups);
    this.persist();
  }

  /**
   * Load task groups from persistence
   */
  async load(): Promise<void> {
    const saved = this.store.get<Record<string, Record<string, TaskGroup>>>(
      WorkspaceStateKey.TASK_GROUPS,
      {},
    );

    this.items.clear();
    for (const [stream, groups] of Object.entries(saved ?? {})) {
      this.items.set(
        stream as StreamTabId,
        new Map(Object.entries(groups ?? {})),
      );
    }

    if (this.items.size > 0) {
      this.logger.debug(`Loaded task groups for ${this.items.size} streams`);
    }
  }

  get(stream: StreamTabId): Map<string, TaskGroup> | undefined {
    return this.items.get(stream);
  }

  has(stream: StreamTabId): boolean {
    return this.items.has(stream);
  }

  keys(): StreamTabId[] {
    return Array.from(this.items.keys());
  }

  getAll(): Map<StreamTabId, Map<string, TaskGroup>> {
    return new Map(this.items);
  }

  private persist(): void {
    const serialized = Object.fromEntries(
      Array.from(this.items.entries(), ([stream, groups]) => [
        stream,
        Object.fromEntries(groups.entries()),
      ]),
    );
    void this.store.update(WorkspaceStateKey.TASK_GROUPS, serialized);
  }
}
