// How a task group reads on screen. The groups themselves are built from
// stage events by the transcript update (`transcriptUpdate.ts`).

import {
  RUN_PHASE,
  type RunOutcome,
  type TaskGroup,
  type TaskGroupStatus,
} from '@shared/schemas';

/**
 * The status a task group RENDERS as, given the outcome its run ended with
 * (`undefined` while the run has not ended).
 *
 * A group is closed by the `GROUP_END` row its producer writes, and a session
 * close ending a run past its budget closes whatever is still open in the
 * same lease-fenced window that writes the run's outcome. A group left
 * `running` is a lie only once nothing can still close it. The view's
 * `durableOutcome` says that, with a value rather than a bit: the outcome
 * the run's `run.end` row wrote, until a follow-up's `run.activate` starts
 * the run again.
 *
 * That value, not a constant: the drain closes an open group with the outcome
 * the run's finalize left standing, so a run that COMPLETED with a group open
 * reads `completed` after the drain. Painting `cancelled` here would make
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
