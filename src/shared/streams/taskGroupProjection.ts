// Host-neutral projection of task-group lifecycle rows from a StreamLog.
//
// The session fold applies entries as they arrive and the CLI rebuilds the
// same task groups from persisted entries. Both paths use this module so
// ordering and orphan GROUP_END behavior remain identical.

import {
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type RunOutcome,
  type RunLogEntry,
  type TaskGroup,
  type TaskGroupStatus,
} from '@shared/schemas';

/**
 * The status a GROUP_END row settles its group on. Producers write
 * `TaskGroupStatus`; an absent value means the group simply completed.
 */
function taskGroupEndStatus(
  value: TaskGroupStatus | undefined,
): TaskGroupStatus {
  return value ?? STREAM_PHASE.COMPLETED;
}

/**
 * The status a task group RENDERS as, given the outcome its run durably
 * settled on (`undefined` while anything can still move the run).
 *
 * A group is closed by the `GROUP_END` row its producer writes, and the host
 * exit drain closes whatever is still open in the same lease-fenced window
 * that writes the run's outcome (`settleLiveSessionExecutions`). A group left
 * `running` is a lie only once nothing can still close it, and a terminal
 * phase alone does not say that: a user stop publishes CANCELLED while the
 * flow is still unwinding in this process, with its stages' `GROUP_END` rows
 * yet to write. The fold's `runDurablyFinal` is the fact that does say
 * it, and it says it with a value rather than a bit — the run's own outcome,
 * whether that came from the durable facts alone or from a terminal phase
 * this process has nothing left to write behind (`finalizeRunTerminal`
 * untracks the execution before storing the phase, so a run that left a group
 * open answers `live` forever).
 *
 * That value, not a constant: the drain closes an open group with the outcome
 * the run's finalize left standing, so a run that COMPLETED with a group open
 * reads `completed` after settlement. Painting `cancelled` here would make
 * the same group read one way before the host exits and another way after.
 *
 * Display only: nothing here is written back to the log.
 */
export function taskGroupDisplayStatus(
  group: Pick<TaskGroup, 'status'>,
  runDurableOutcome: RunOutcome | undefined,
): TaskGroupStatus {
  return runDurableOutcome !== undefined &&
    group.status === STREAM_PHASE.RUNNING
    ? runDurableOutcome
    : group.status;
}

type TaskGroupLifecycleEntry = Extract<
  RunLogEntry,
  {
    type:
      | typeof STREAM_LOG_ENTRY_TYPES.GROUP_START
      | typeof STREAM_LOG_ENTRY_TYPES.GROUP_END;
  }
>;

/**
 * Whether an entry is a task-group lifecycle row: the one rule for what
 * `upsertTaskGroupFromStreamLog` writes, so a caller that must know before
 * the call (the session fold, which copies the array it is about to write)
 * reads the same answer the reducer does.
 */
export function isTaskGroupLifecycleEntry(
  entry: RunLogEntry,
): entry is TaskGroupLifecycleEntry {
  return (
    entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START ||
    entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END
  );
}

/**
 * Apply one StreamLog entry to an existing task-group projection.
 *
 * Returns `true` exactly when the entry is a task-group lifecycle row. The
 * array and index are mutated together so incremental consumers retain O(1)
 * replacement, and a from-scratch replay over a complete log through this
 * same reducer yields the identical result (the resync path).
 */
export function upsertTaskGroupFromRunLog(
  taskGroups: TaskGroup[],
  taskGroupIndex: Map<string, number>,
  entry: RunLogEntry,
): boolean {
  if (!isTaskGroupLifecycleEntry(entry)) return false;

  const cachedIndex = taskGroupIndex.get(entry.id);
  const groupIndex =
    cachedIndex !== undefined && taskGroups[cachedIndex]?.id === entry.id
      ? cachedIndex
      : taskGroups.findIndex((group) => group.id === entry.id);

  if (groupIndex >= 0 && groupIndex !== cachedIndex) {
    taskGroupIndex.set(entry.id, groupIndex);
  }

  const payload = entry.data;
  const lifecycleFields = {
    ...(entry.groupId ? { parentGroupId: entry.groupId } : {}),
    ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
    ...(payload.index !== undefined ? { index: payload.index } : {}),
    ...(payload.attemptId !== undefined
      ? { attemptId: payload.attemptId }
      : {}),
    ...(payload.total !== undefined ? { total: payload.total } : {}),
  };

  if (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START) {
    // The run has not ended, so an absent status means "running".
    const startStatus = payload.status ?? STREAM_PHASE.RUNNING;
    const name = entry.text ?? payload.name ?? entry.id;
    const nextGroup: TaskGroup = {
      id: entry.id,
      name,
      startTime: entry.timestamp,
      status: startStatus,
      ...lifecycleFields,
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
      ...lifecycleFields,
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
