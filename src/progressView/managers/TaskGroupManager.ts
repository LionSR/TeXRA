// Local imports - shared schemas
import {
  STREAM_STATUS,
  type StreamTabId,
  type TaskGroup,
  type UpdateTaskGroupPayload,
} from '@shared/schemas';

// Local imports - common
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - progress view
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import {
  mapToRecord,
  recordToMap,
} from '@progressView/persistence/serializationUtils';

/**
 * Manages task groups collection with persistence.
 * Handles adding, updating, and managing task groups for different streams.
 */
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  Map<string, TaskGroup>
> {
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.TASK_GROUPS, storage);
    this.logger = new AgentLogger('TaskGroupManager');
  }

  /**
   * Add a task group to a stream
   */
  async addGroup(
    stream: StreamTabId,
    groupId: string,
    group: TaskGroup,
  ): Promise<void> {
    let streamGroups = this.get(stream);
    if (!streamGroups) {
      streamGroups = new Map();
      this.items.set(stream, streamGroups);
    }

    streamGroups.set(groupId, { ...group });
    await this.save();
  }

  /**
   * Update an existing task group.
   * Uses UpdateTaskGroupPayload from event bus schema as single source of truth.
   */
  async updateGroup({
    streamId,
    id,
    status,
    endTime,
  }: UpdateTaskGroupPayload): Promise<void> {
    const streamGroups = this.get(streamId);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot update group ${id}: stream ${streamId} not found`,
      );
      return;
    }

    const group = streamGroups.get(id);
    if (!group) {
      this.logger.warn(
        `Cannot update group ${id}: group not found in stream ${streamId}`,
      );
      return;
    }

    // Apply updates - only include endTime if explicitly provided
    const updated: TaskGroup = {
      ...group,
      status,
      ...(endTime !== undefined && { endTime }),
    };
    streamGroups.set(id, updated);
    await this.save();
  }

  async endRunningGroups(now: number = Date.now()): Promise<StreamTabId[]> {
    const affected: StreamTabId[] = [];

    for (const [streamId, groups] of this.items.entries()) {
      let count = 0;
      for (const group of groups.values()) {
        if (group.status === STREAM_STATUS.RUNNING) {
          group.status = STREAM_STATUS.ERROR;
          group.endTime = now;
          count++;
        }
      }

      if (count > 0) {
        affected.push(streamId);
        this.logger.debug(
          `Marked ${count} running task groups in stream ${streamId} as ERROR after reload`,
        );
      }
    }

    if (affected.length > 0) {
      await this.save();
    }

    return affected;
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
      this.logger.debug(`Loaded task groups for ${this.items.size} streams`);
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
  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Map<string, TaskGroup> {
    return recordToMap<TaskGroup>(data);
  }
}
