// Host-neutral projection of task groups from stage events.
//
// The session fold (`sessionFold.ts`) is the one caller; it owns the group
// positions, this module what one stage event writes.

import {
  RUN_PHASE,
  type RunOutcome,
  type TaskGroup,
  type TaskGroupStatus,
  type TranscriptEvent,
} from '@shared/schemas';

/**
 * The status a task group RENDERS as, given the outcome its run durably
 * settled on (`undefined` while anything can still move the run).
 *
 * A group is closed by the `GROUP_END` row its producer writes, and a session
 * close settling a run past its budget closes whatever is still open in the
 * same lease-fenced window that writes the run's outcome. A group left
 * `running` is a lie only once nothing can still close it, and a terminal
 * phase alone does not say that: a user stop publishes CANCELLED while the
 * flow is still unwinding in this process, with its stages' `GROUP_END` rows
 * yet to write. The fold's `runDurablyFinal` is the fact that does say
 * it, and it says it with a value rather than a bit — the run's own outcome,
 * whether that came from the durable facts alone or from a terminal phase
 * this process has nothing left to write behind (`finalizeRunTerminal`
 * untracks the run before storing the phase, so a run that left a group
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
  return runDurableOutcome !== undefined && group.status === RUN_PHASE.RUNNING
    ? runDurableOutcome
    : group.status;
}

type StageEvent = Extract<
  TranscriptEvent,
  { readonly type: 'stage.start' | 'stage.end' }
>;

/**
 * The task group one stage event writes over `current`, the group it names
 * (undefined when none is open), at the event's clock `at`. A start opens
 * the group whole, tagging a workflow phase with `attemptId`, the attempt the
 * newest `workflow.plan` declared; an end closes the group its start opened
 * and writes nothing for a group no start opened.
 */
export function taskGroupOnStage(
  current: TaskGroup | undefined,
  event: StageEvent,
  at: number,
  attemptId: string | undefined,
): TaskGroup | undefined {
  if (event.type === 'stage.end') {
    return current && { ...current, status: event.status, endTime: at };
  }
  return {
    id: event.id,
    name: event.label,
    startTime: at,
    status: RUN_PHASE.RUNNING,
    ...(event.parentId ? { parentGroupId: event.parentId } : {}),
    ...(event.kind != null ? { kind: event.kind } : {}),
    ...(event.index != null ? { index: event.index } : {}),
    ...(event.kind === 'phase' && attemptId !== undefined ? { attemptId } : {}),
    ...(event.total != null ? { total: event.total } : {}),
  };
}
