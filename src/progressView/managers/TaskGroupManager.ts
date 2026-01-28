import {
  STREAM_STATUS,
  TaskGroupSchema,
  type StreamTabId,
  type TaskGroup,
  type UpdateTaskGroupPayload,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createRecordToMapSchema } from '@progressView/persistence/schemaUtils';
import { mapToRecord } from '@progressView/persistence/serializationUtils';

/** Schema for deserializing persisted task groups */
const TaskGroupsMapSchema = createRecordToMapSchema(TaskGroupSchema);

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

  /** Add a task group to a stream */
  async addGroup(
    stream: StreamTabId,
    groupId: string,
    group: TaskGroup,
  ): Promise<void> {
    const streamGroups = this.getOrCreate(stream, () => new Map());
    streamGroups.set(groupId, { ...group });
    await this.save();
  }

  /**
   * Update an existing task group.
   * Uses UpdateTaskGroupPayload from event bus schema as single source of truth.
   */
  async updateGroup(payload: UpdateTaskGroupPayload): Promise<void> {
    const streamGroups = this.get(payload.streamId);
    if (!streamGroups) {
      this.logger.warn(
        `Cannot update group ${payload.id}: stream ${payload.streamId} not found`,
      );
      return;
    }

    const group = streamGroups.get(payload.id);
    if (!group) {
      this.logger.warn(
        `Cannot update group ${payload.id}: group not found in stream ${payload.streamId}`,
      );
      return;
    }

    group.status = payload.status;
    if (payload.endTime !== undefined) {
      group.endTime = payload.endTime;
    }
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

  /** Normalize loaded groups with schema validation */
  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Map<string, TaskGroup> {
    return TaskGroupsMapSchema.parse(data);
  }
}
