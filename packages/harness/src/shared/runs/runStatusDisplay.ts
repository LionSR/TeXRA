import {
  ownerIdentity,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  type OwnerId,
  type ResumeBlocker,
  type RoundStage,
  type RunId,
  type RunLifecycleStatus,
  type RunSubstate,
} from '@shared/schemas';
import type { RunGroup } from '@shared/session/sessionView';

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
 * The one status label table (PRD one-fold-three-renderers, G4): the fold
 * reads it into `RunView.statusLabel`, and every renderer prints that
 * word as is. `packages/cli/scripts/validate-run.mjs` pins the completed and
 * stopped words from here against the real headless run.
 */
const RUN_STATUS_LABELS: Record<RunStatusCopyKey, string> = {
  [RUN_SUBSTATE.STARTING]: 'Initializing',
  [RUN_PHASE.RUNNING]: 'Running',
  [RUN_PHASE.FAILED]: 'Error',
  [RUN_PHASE.COMPLETED]: 'Completed',
  [RUN_PHASE.CANCELLED]: 'Stopped',
  ready: 'Ready',
  [RUN_PHASE.WAITING]: 'Idle',
  [RUN_SUBSTATE.RESUMING]: 'Resuming',
  [RUN_SUBSTATE.PAUSED]: 'Paused',
  [RUN_SUBSTATE.RESULT_WAITING]: 'Result waiting: parent is open elsewhere',
  [RUN_DISPLAY_INTERRUPTED]: 'Interrupted',
  [RUN_DISPLAY_WAITING_ON_USER]: 'Waiting on you',
};

/**
 * The one status-to-tone mapping (PRD one-fold-three-renderers, G4 and 15):
 * a fact-only word every host paints in its own colour vocabulary. Keyed by
 * the same display key as the labels above, so a status that gains a label
 * must gain a tone in the same edit.
 */
export const RUN_STATUS_TONE = {
  RUNNING: 'running',
  SUCCESS: 'success',
  DANGER: 'danger',
  NEUTRAL: 'neutral',
  WARNING: 'warning',
} as const;
type RunStatusTone = (typeof RUN_STATUS_TONE)[keyof typeof RUN_STATUS_TONE];

const RUN_STATUS_TONES: Record<RunStatusCopyKey, RunStatusTone> = {
  [RUN_SUBSTATE.STARTING]: RUN_STATUS_TONE.RUNNING,
  [RUN_PHASE.RUNNING]: RUN_STATUS_TONE.RUNNING,
  [RUN_PHASE.FAILED]: RUN_STATUS_TONE.DANGER,
  [RUN_PHASE.COMPLETED]: RUN_STATUS_TONE.SUCCESS,
  [RUN_PHASE.CANCELLED]: RUN_STATUS_TONE.NEUTRAL,
  ready: RUN_STATUS_TONE.NEUTRAL,
  [RUN_PHASE.WAITING]: RUN_STATUS_TONE.NEUTRAL,
  [RUN_SUBSTATE.RESUMING]: RUN_STATUS_TONE.RUNNING,
  [RUN_SUBSTATE.PAUSED]: RUN_STATUS_TONE.WARNING,
  [RUN_SUBSTATE.RESULT_WAITING]: RUN_STATUS_TONE.WARNING,
  [RUN_DISPLAY_INTERRUPTED]: RUN_STATUS_TONE.WARNING,
  [RUN_DISPLAY_WAITING_ON_USER]: RUN_STATUS_TONE.WARNING,
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
): { readonly statusLabel: string; readonly tone: RunStatusTone } {
  let key: RunStatusCopyKey = runStatusDisplayKey(status, options.substate);
  if (options.interrupted) key = RUN_DISPLAY_INTERRUPTED;
  else if (options.waiting) key = RUN_DISPLAY_WAITING_ON_USER;
  return {
    statusLabel: RUN_STATUS_LABELS[key],
    tone: RUN_STATUS_TONES[key],
  };
}

/** Banner copy for the fold's interrupted reading: the process running the
 *  run is gone; a pending approval stays listed, so a resume re-asks it. */
export function runInterruptedMessage(): string {
  return 'The process running this task stopped before it finished. Resume it to continue.';
}

/** Banner copy for a run a resume found blocked: what it waits for, and
 *  whether it continues by itself then (`retry`: a resume was asked for). */
export function runResumeBlockedMessage(
  reason: ResumeBlocker,
  retry: boolean,
): string {
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

/** The clause naming the process that holds a run: the pid and the machine
 *  recorded in its claim, the two parts of an identity a user can act on. One
 *  home, read by the refusal below and by the liveness ladder's unsettled
 *  reason, so the two wordings cannot drift apart. */
function runHeldClause(ownerId: OwnerId): string {
  const { pid, hostname } = ownerIdentity(ownerId);
  return `held by another TeXRA process (pid ${pid} on ${hostname})`;
}

/** The refusal a host prints when another TeXRA process holds a run: the
 *  owner named by the pid and machine recorded in its claim. */
export function runHeldByProcessMessage(
  runId: RunId,
  ownerId: OwnerId,
): string {
  return `Task ${runId} is ${runHeldClause(ownerId)}.`;
}

export function formatRunStatusLabel(status: RunLifecycleStatus): string {
  return RUN_STATUS_LABELS[runStatusDisplayKey(status)];
}

/** Compact round/turn progress label: `r2/3` when the planned total is known
 *  (workflow runs), else `r2`. Zero-based `index` renders one-based. */
export function formatRoundStageLabel(stage: Readonly<RoundStage>): string {
  const current = `r${stage.index + 1}`;
  return stage.total !== undefined ? `${current}/${stage.total}` : current;
}

/** Compact position label: `t2` for a run's second turn. */
export function formatLoopPositionLabel(
  turn: number | null | undefined,
): string | undefined {
  return turn == null ? undefined : `t${turn}`;
}

/**
 * One section per `group` arm, and the order the sections are painted in.
 * Both surfaces that group a run list — the webview tab strip and the
 * TUI's run tree — read this table rather than spelling the four labels
 * again, so a renamed section cannot say one thing in the dock and another
 * in the terminal.
 *
 * Deep-frozen: the record crosses a module boundary into two renderers, and
 * `readonly` is compile-time only.
 */
export const RUN_GROUP_LABELS: Readonly<Record<RunGroup, string>> =
  Object.freeze({
    running: 'Running',
    waiting: 'Waiting on you',
    interrupted: 'Interrupted',
    recent: 'Recent',
  });

/** Section order, in the group union's own order. */
export const RUN_GROUP_ORDER: readonly RunGroup[] = Object.freeze(
  Object.keys(RUN_GROUP_LABELS) as RunGroup[],
);
