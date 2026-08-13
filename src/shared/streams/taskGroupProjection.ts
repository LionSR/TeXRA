// Host-neutral projection of task-group lifecycle rows from a StreamLog.
//
// The extension applies entries incrementally as LOG_DELTA messages arrive,
// while the CLI also needs to rebuild the same task groups from persisted
// entries. Both paths use this module so ordering, legacy status recovery,
// and orphan GROUP_END behavior remain identical.

import {
  END_GROUP_STATUS,
  GroupLogPayloadSchema,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  TaskGroupStatusSchema,
  type EndGroupStatus,
  type StreamLogEntry,
  type TaskGroup,
  type TaskGroupStatus,
} from '@shared/schemas';

/**
 * Normalize the two status vocabularies that can occur on a GROUP_END row.
 *
 * Current producers write `TaskGroupStatus`. A trace exported before the
 * status migration can still contain the legacy `EndGroupStatus`, so the
 * read projection maps it to the same canonical value used by persistence.
 */
function taskGroupEndStatus(
  value: TaskGroupStatus | EndGroupStatus | undefined,
): TaskGroupStatus {
  const native = TaskGroupStatusSchema.safeParse(value);
  if (native.success) return native.data;
  if (value === END_GROUP_STATUS.ERROR) return STREAM_PHASE.FAILED;
  // Legacy `stopped`, an unrecognized value, and an absent one all read as a
  // group that ended without a recorded failure.
  return STREAM_PHASE.COMPLETED;
}

/**
 * Recover the exact zero-based `rN` round labels written before typed stage
 * metadata was persisted. Human-facing `Round N` labels have not had one
 * stable indexing convention, so they remain unclassified rather than being
 * assigned a guessed index.
 */
function taskGroupStageMetadata(
  name: string,
  kind: TaskGroup['kind'],
  index: number | undefined,
): Pick<TaskGroup, 'kind' | 'index'> {
  const legacyMatch =
    kind === undefined || kind === 'round' ? /^r(\d+)$/.exec(name) : null;
  const inferredRoundIndex = legacyMatch
    ? Number.parseInt(legacyMatch[1], 10)
    : undefined;
  const normalizedKind =
    kind ?? (inferredRoundIndex !== undefined ? 'round' : undefined);
  const normalizedIndex = index ?? inferredRoundIndex;
  return {
    ...(normalizedKind !== undefined ? { kind: normalizedKind } : {}),
    ...(normalizedIndex !== undefined ? { index: normalizedIndex } : {}),
  };
}

/**
 * Apply one StreamLog entry to an existing task-group projection.
 *
 * Returns `true` exactly when the entry is a task-group lifecycle row. The
 * array and index are mutated together so incremental consumers retain O(1)
 * replacement, and a from-scratch replay over a complete log through this
 * same reducer yields the identical result (the resync path).
 */
export function upsertTaskGroupFromStreamLog(
  taskGroups: TaskGroup[],
  taskGroupIndex: Map<string, number>,
  entry: StreamLogEntry,
): boolean {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END
  ) {
    return false;
  }

  const cachedIndex = taskGroupIndex.get(entry.id);
  const groupIndex =
    cachedIndex !== undefined && taskGroups[cachedIndex]?.id === entry.id
      ? cachedIndex
      : taskGroups.findIndex((group) => group.id === entry.id);

  if (groupIndex >= 0 && groupIndex !== cachedIndex) {
    taskGroupIndex.set(entry.id, groupIndex);
  }

  // A missing payload is valid for legacy lifecycle rows. A present malformed
  // payload is not: in particular, erasing corrupted attempt ownership would
  // turn a phase row into an apparently unowned generic group.
  const parsedPayload = GroupLogPayloadSchema.safeParse(
    entry.data === undefined ? {} : entry.data,
  );
  if (!parsedPayload.success) {
    // A malformed terminal row cannot safely settle the projected group, but
    // retaining its valid start would leave the UI claiming that work is
    // still running forever. Omit that presentation row without inventing a
    // session outcome or accepting the corrupt ownership metadata.
    if (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END && groupIndex >= 0) {
      taskGroups.splice(groupIndex, 1);
      taskGroupIndex.delete(entry.id);
      for (const [index, group] of taskGroups.entries()) {
        if (index >= groupIndex) taskGroupIndex.set(group.id, index);
      }
    }
    return true;
  }
  const payload = parsedPayload.data;

  if (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START) {
    // GROUP_START only carries the native status vocabulary because the run
    // has not ended. Invalid or absent values therefore mean "running".
    const startStatus = TaskGroupStatusSchema.safeParse(payload.status);
    const name = entry.text ?? payload.name ?? entry.id;
    const nextGroup: TaskGroup = {
      id: entry.id,
      name,
      startTime: entry.timestamp,
      status: startStatus.success ? startStatus.data : STREAM_PHASE.RUNNING,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
      ...taskGroupStageMetadata(name, payload.kind, payload.index),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
    };

    if (groupIndex === -1) {
      taskGroupIndex.set(entry.id, taskGroups.length);
      taskGroups.push(nextGroup);
    } else {
      taskGroups[groupIndex] = nextGroup;
    }
    return true;
  }

  const status = taskGroupEndStatus(payload.status);
  const endTime = payload.endTime;

  if (groupIndex === -1) {
    const name = entry.text ?? entry.id;
    taskGroupIndex.set(entry.id, taskGroups.length);
    taskGroups.push({
      id: entry.id,
      name,
      startTime: entry.timestamp,
      status,
      ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
      ...taskGroupStageMetadata(name, payload.kind, payload.index),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    });
  } else {
    const current = taskGroups[groupIndex];
    taskGroups[groupIndex] = {
      ...current,
      status,
      ...(endTime !== undefined ? { endTime } : {}),
    };
  }

  return true;
}
