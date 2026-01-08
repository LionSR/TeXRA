// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import { TaskGroup } from '@logger/LogTypes';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';
import {
  mapToRecord,
  recordToMap,
} from '@progressView/persistence/serializationUtils';
import type { UpdateTaskGroupPayload } from '@eventBus/schemas';

/**
 * Manages task groups collection with persistence.
 * Handles adding, updating, and managing task groups for different streams.
 *
 * Uses file-based storage to enable lazy loading and avoid VS Code IPC limits.
 */
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  Map<string, TaskGroup>
> {
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    // Enable file-based storage for lazy loading
    super(WorkspaceStateKey.TASK_GROUPS, storage, { useFileStorage: true });
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
    // Ensure stream data is loaded before modifying
    await this.ensureLoaded(stream);

    if (!this.has(stream)) {
      this.items.set(stream, new Map());
      this.knownKeys.add(stream);
      this.loadedKeys.add(stream);
    }

    const streamGroups = this.get(stream)!;
    streamGroups.set(groupId, { ...group });
    await this.saveEntry(stream, streamGroups);
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
    // Ensure stream data is loaded before modifying
    await this.ensureLoaded(stream);

    const streamGroups = this.get(stream);
    if (!streamGroups) {
      this.logger.warn(`Cannot update group ${id}: stream ${stream} not found`);
      return;
    }

    const group = streamGroups.get(id);
    if (!group) {
      this.logger.warn(
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
    await this.saveEntry(stream, streamGroups);
  }

  async endRunningGroups(now: number = Date.now()): Promise<StreamTabId[]> {
    const affected: StreamTabId[] = [];

    // Load all streams to check for running groups
    for (const streamId of this.keys()) {
      await this.ensureLoaded(streamId);
    }

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
        await this.saveEntry(streamId, groups);
        this.logger.debug(
          `Marked running task groups in stream ${streamId} as ERROR after reload`,
        );
      }
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
   * Get a specific task group, ensuring data is loaded first.
   */
  async getGroupAsync(
    stream: StreamTabId,
    groupId: string,
  ): Promise<TaskGroup | undefined> {
    await this.ensureLoaded(stream);
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
   * Get all groups for a stream, ensuring data is loaded first.
   */
  async getStreamGroupsAsync(stream: StreamTabId): Promise<Map<string, TaskGroup>> {
    await this.ensureLoaded(stream);
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
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<Map<string, TaskGroup>> {
    return recordToMap<TaskGroup>(data);
  }
}
