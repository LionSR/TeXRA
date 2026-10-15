import {
  ownerIdentity,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  type OwnerId,
  type ResumeBlocker,
  type RunId,
  type RunLifecycleStatus,
  type RunSubstate,
} from '@shared/schemas';

type RunStatusDisplayKey =
  | Exclude<RunLifecycleStatus, typeof RUN_LIFECYCLE_READY>
  | RunSubstate
  | 'ready';

/**
 * The fold's interrupted reading (PRD one-fold-three-renderers, 5.2): an
 * in-flight run whose owner process nobody holds. A copy key over the
 * durable phase, never a lifecycle status or a host display key, so the
 * durable event set and the hosts' per-status tables stay what they are and
 * only the label and tone change.
 */
const RUN_DISPLAY_INTERRUPTED = 'interrupted';
/** The fold's waiting reading: a held run parked on the user's answer, such
 *  as a failed model request asking to retry or stop. */
const RUN_DISPLAY_WAITING_ON_USER = 'waitingOnUser';
type RunStatusCopyKey =
  | RunStatusDisplayKey
  | typeof RUN_DISPLAY_INTERRUPTED
  | typeof RUN_DISPLAY_WAITING_ON_USER;

/**
 * Display key for a `RunLifecycleStatus` (a `RunPhase`, or the `ready`
 * idle sentinel every host defaults an unstarted run to).
 */
function runStatusDisplayKey(
  status: RunLifecycleStatus,
  substate?: RunSubstate,
): RunStatusDisplayKey {
  if (status === RUN_LIFECYCLE_READY) return 'ready';
  return substate ?? status;
}

/**
 * The tone (PRD one-fold-three-renderers, G4 and 15): a fact-only word
 * every host paints in its own colour vocabulary.
 */
export const RUN_STATUS_TONE = {
  RUNNING: 'running',
  SUCCESS: 'success',
  DANGER: 'danger',
  NEUTRAL: 'neutral',
  WARNING: 'warning',
} as const;
type RunStatusTone = (typeof RUN_STATUS_TONE)[keyof typeof RUN_STATUS_TONE];
type RunStatusCopy = {
  readonly statusLabel: string;
  readonly tone: RunStatusTone;
};

/**
 * The one status copy table (G4): the fold reads it into
 * `RunView.statusLabel` and `tone`, and every renderer prints that word as
 * is. `packages/cli/scripts/validate-run.mjs` pins the completed and
 * stopped words from here against the real headless run.
 */
const RUN_STATUS_COPY: Record<RunStatusCopyKey, RunStatusCopy> = {
  [RUN_SUBSTATE.STARTING]: { statusLabel: 'Initializing', tone: 'running' },
  [RUN_PHASE.RUNNING]: { statusLabel: 'Running', tone: 'running' },
  [RUN_PHASE.FAILED]: { statusLabel: 'Error', tone: 'danger' },
  [RUN_PHASE.COMPLETED]: { statusLabel: 'Completed', tone: 'success' },
  [RUN_PHASE.CANCELLED]: { statusLabel: 'Stopped', tone: 'neutral' },
  ready: { statusLabel: 'Ready', tone: 'neutral' },
  [RUN_PHASE.WAITING]: { statusLabel: 'Idle', tone: 'neutral' },
  [RUN_SUBSTATE.RESUMING]: { statusLabel: 'Resuming', tone: 'running' },
  [RUN_SUBSTATE.PAUSED]: { statusLabel: 'Paused', tone: 'warning' },
  [RUN_SUBSTATE.RESULT_WAITING]: {
    statusLabel: 'Result waiting: parent is open elsewhere',
    tone: 'warning',
  },
  [RUN_DISPLAY_INTERRUPTED]: { statusLabel: 'Interrupted', tone: 'warning' },
  [RUN_DISPLAY_WAITING_ON_USER]: {
    statusLabel: 'Waiting on you',
    tone: 'warning',
  },
};

/**
 * The label and tone pair a `RunView` carries (G4), read from the one
 * table through one display key: the status and substate, or the fold's
 * interrupted reading when an in-flight run has lost its owner.
 */
export function runStatusCopy(
  status: RunLifecycleStatus,
  options: {
    readonly substate?: RunSubstate;
    readonly interrupted?: boolean;
    readonly waiting?: boolean;
  } = {},
): RunStatusCopy {
  let key: RunStatusCopyKey = runStatusDisplayKey(status, options.substate);
  if (options.interrupted) key = RUN_DISPLAY_INTERRUPTED;
  else if (options.waiting) key = RUN_DISPLAY_WAITING_ON_USER;
  return { ...RUN_STATUS_COPY[key] };
}

/** Banner copy for the fold's interrupted reading: the process running the
 *  run is gone; a pending approval stays listed, so a resume re-asks it. */
export const RUN_INTERRUPTED_MESSAGE =
  'The process running this task stopped before it finished. Resume it to continue.';

/** Banner copy for a run a resume found blocked: what it waits for, and
 *  whether it continues by itself then (`retry`: a resume was asked for). */
export function runResumeBlockedMessage({
  reason,
  retry,
}: {
  readonly reason: ResumeBlocker;
  readonly retry: boolean;
}): string {
  const then = retry ? 'It continues once' : 'You can resume it once';
  switch (reason.kind) {
    case 'agentMissing':
      return `This task's agent, ${reason.name}, is no longer installed. ${then} the agent is back.`;
    case 'pluginOff':
      return `This task's agent comes from the ${reason.name} plugin, which is off. ${then} the plugin is on.`;
    case 'pluginUntrusted':
      return `This task's agent comes from the ${reason.name} plugin, which is not trusted as it is now. ${then} you trust it.`;
  }
}

/** Banner copy for a run with a row that does not decode: shown, never
 *  opened. */
export const RUN_DAMAGED_MESSAGE =
  "Part of this task's saved history is damaged, so it cannot be opened or resumed.";

/** Banner copy for a run with a row an earlier build wrote at a version
 *  this one has no upcaster for: shown, never opened. */
export const RUN_EARLIER_BUILD_MESSAGE =
  "This task was written by an earlier build of TeXRA; it can't be opened by this one.";

/** Banner and tooltip copy for a run another TeXRA process holds, named by
 *  its pid: the one part of a process identity a user can act on. */
export function runHeldMessage(pid: number): string {
  return `Held by another TeXRA process (pid ${pid}). Let it finish or close it; if it is gone, Delete removes the task.`;
}

/** The refusal a host prints when another TeXRA process holds a run: the
 *  owner named by the pid and machine recorded in its claim, the two parts
 *  of an identity a user can act on. */
export function runHeldByProcessMessage(
  runId: RunId,
  ownerId: OwnerId,
): string {
  const { pid, hostname } = ownerIdentity(ownerId);
  return `Task ${runId} is held by another TeXRA process (pid ${pid} on ${hostname}).`;
}

export function formatRunStatusLabel(status: RunLifecycleStatus): string {
  return RUN_STATUS_COPY[runStatusDisplayKey(status)].statusLabel;
}
