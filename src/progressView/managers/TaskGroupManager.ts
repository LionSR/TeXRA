// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { TaskGroup } from '@logger/LogTypes';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import type { UpdateTaskGroupPayload } from '@eventBus/schemas';
import { ManagerLogger } from './ManagerLogger';

/**
 * Manages task groups collection with persistence.
 * Handles adding, updating, and managing task groups for different streams.
 */
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  Map<string, TaskGroup>
> {
  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.TASK_GROUPS, storage, ['texra.logGroups']);
  }

  /**
   * Add a task group to a stream
   */
  async addGroup(
    stream: StreamTabId,
    groupId: string,
    group: TaskGroup,
  ): Promise<void> {
    if (!this.has(stream)) {
      this.items.set(stream, new Map());
    }

    const streamGroups = this.get(stream)!;
    streamGroups.set(groupId, { ...group });
    await this.save();
  }

  /**
   * Update an existing task group.
   * Uses UpdateTaskGroupPayload from event bus schema as single source of truth.
   */
  async updateGroup({
    stream,
    id,
    status,
    endTime,
  }: UpdateTaskGroupPayload): Promise<void> {
    const streamGroups = this.get(stream);
    if (!streamGroups) {
      ManagerLogger.warn(`Cannot update group ${id}: stream ${stream} not found`);
      return;
    }

    const group = streamGroups.get(id);
    if (!group) {
      ManagerLogger.warn(
        `Cannot update group ${id}: group not found in stream ${stream}`,
      );
      return;
    }

    // Apply updates - only include endTime if explicitly provided
    const updated: TaskGroup = { ...group, status };
    if (endTime !== undefined) {
      updated.endTime = endTime;
    }
    streamGroups.set(id, updated);
    await this.save();
  }

  async endRunningGroups(now: number = Date.now()): Promise<StreamTabId[]> {
    const affected: StreamTabId[] = [];

    for (const [streamId, groups] of this.items.entries()) {
      let updated = false;

      for (const group of groups.values()) {
        if (group.status === STREAM_STATUS.RUNNING) {
          group.status = STREAM_STATUS.ERROR;
          group.endTime = now;
          updated = true;
        }
      }

      if (updated) {
        affected.push(streamId);
        ManagerLogger.debug(
          `Marked running task groups in stream ${streamId} as ERROR after reload`,
        );
      }
    }

    if (affected.length > 0) {
      await this.save();
    }

    return affected;
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
   * Load task groups from persistence
   */
  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      ManagerLogger.debug(`Loaded task groups for ${this.items.size} streams`);
    }
  }

  /** Convert groups map to plain object */
  protected override serialize(
    value: Map<string, TaskGroup>,
    _key: StreamTabId,
  ): unknown {
    return mapToRecord(value);
  }

  /** Normalize loaded groups */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<Map<string, TaskGroup>> {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const entries = Object.entries(data as Record<string, TaskGroup>);
    return new Map(entries as [string, TaskGroup][]);
  }
}
