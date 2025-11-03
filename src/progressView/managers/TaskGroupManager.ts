// Local imports - progress view persistence
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports - identifiers and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - modules
import { STATUS } from '../modules/constants.js';

// Local imports - types
import type { TaskGroup } from '@logger/LogTypes';

type TaskGroupRecord = Record<string, TaskGroup>;

export interface TaskGroupUpdatePayload {
  stream: StreamTabId;
  groupId: string;
  updates: Partial<TaskGroup>;
}

/**
 * Manages task groups collection with persistence.
 * Stores groups as plain objects keyed by group ID for straightforward
 * serialization.
 */
export class TaskGroupManager extends PersistentMapManager<
  StreamTabId,
  TaskGroupRecord
> {
  private readonly logger: AgentLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.TASK_GROUPS);
    this.logger = new AgentLogger('TaskGroupManager');
  }

  addGroup(stream: StreamTabId, groupId: string, group: TaskGroup): void {
    const groups = this.ensureGroups(stream);
    groups[groupId] = { ...group };
    this.save();
  }

  updateGroup({ stream, groupId, updates }: TaskGroupUpdatePayload): void {
    const groups = this.ensureGroups(stream);
    const existing = groups[groupId];
    if (!existing) {
      groups[groupId] = {
        id: groupId,
        name: updates.name ?? groupId,
        startTime: updates.startTime ?? Date.now(),
        endTime: updates.endTime,
        status: updates.status ?? STATUS.RUNNING,
        parentGroupId: updates.parentGroupId,
      };
    } else {
      groups[groupId] = { ...existing, ...updates };
    }
    this.save();
  }

  getGroup(stream: StreamTabId, groupId: string): TaskGroup | undefined {
    const groups = this.items.get(stream);
    return groups ? groups[groupId] : undefined;
  }

  getStreamGroups(stream: StreamTabId): TaskGroupRecord {
    return this.items.get(stream) ?? {};
  }

  hasStream(stream: StreamTabId): boolean {
    return this.items.has(stream);
  }

  deleteStream(stream: StreamTabId): void {
    super.delete(stream);
  }

  clear(): void {
    super.clear();
  }

  markRunningGroupsErrored(timestamp: number): StreamTabId[] {
    const affected: StreamTabId[] = [];

    for (const [stream, groups] of this.items.entries()) {
      let updated = false;
      for (const [id, group] of Object.entries(groups)) {
        if (group.status === STATUS.RUNNING) {
          groups[id] = {
            ...group,
            status: STATUS.ERROR,
            endTime: group.endTime ?? timestamp,
          };
          updated = true;
        }
      }

      if (updated) {
        affected.push(stream);
      }
    }

    if (affected.length > 0) {
      this.save();
    }

    return affected;
  }

  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      this.logger.debug(`Loaded task groups for ${this.items.size} streams`);
    }
  }

  protected override serialize(
    value: TaskGroupRecord,
    _key: StreamTabId,
  ): unknown {
    return value;
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<TaskGroupRecord> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const record: TaskGroupRecord = {};
    for (const [groupId, raw] of Object.entries(
      data as Record<string, TaskGroup | undefined>,
    )) {
      if (!raw) {
        continue;
      }
      record[groupId] = { ...raw, id: raw.id ?? groupId };
    }

    return record;
  }

  private ensureGroups(stream: StreamTabId): TaskGroupRecord {
    let groups = this.items.get(stream);
    if (!groups) {
      groups = {};
      this.items.set(stream, groups);
    }
    return groups;
  }
}
