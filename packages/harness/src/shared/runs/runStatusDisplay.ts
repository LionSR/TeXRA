import {
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  type ResumeBlocker,
  type RunLifecycleStatus,
  type RunSubstate,
} from '@shared/schemas';

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

/**
 * The one status table (G4): each way a run's status reads, and its tone.
 * A key is the run's phase, its substate when it has one, `ready` before
 * its first activation, or one of the fold's two readings: `interrupted`
 * (an in-flight run whose owner process nobody holds) and `waitingOnUser`
 * (a run parked on the user's answer). The words are the app's
 * (`@ui/copy/runStatus`); the fold stores the key.
 */
const RUN_STATUS_TONE_OF = {
  [RUN_SUBSTATE.STARTING]: 'running',
  [RUN_PHASE.RUNNING]: 'running',
  [RUN_PHASE.FAILED]: 'danger',
  [RUN_PHASE.COMPLETED]: 'success',
  [RUN_PHASE.CANCELLED]: 'neutral',
  [RUN_LIFECYCLE_READY]: 'neutral',
  [RUN_PHASE.WAITING]: 'neutral',
  [RUN_SUBSTATE.RESUMING]: 'running',
  [RUN_SUBSTATE.PAUSED]: 'warning',
  [RUN_SUBSTATE.RESULT_WAITING]: 'warning',
  interrupted: 'warning',
  waitingOnUser: 'warning',
} as const satisfies Record<string, RunStatusTone>;

/** How a run's status reads: one key of the status table. */
export type RunStatusKey = keyof typeof RUN_STATUS_TONE_OF;
/** Every key of the status table, the enum `RunView.statusKey` holds. */
// cast: `Object.keys` widens to string[]; the table's own keys are these.
export const RUN_STATUS_KEYS = Object.keys(RUN_STATUS_TONE_OF) as [
  RunStatusKey,
  ...RunStatusKey[],
];

/**
 * The status key and tone a `RunView` carries (G4), read from the one
 * table: the status and substate, or the fold's interrupted or waiting
 * reading.
 */
export function runStatus(
  status: RunLifecycleStatus,
  options: {
    readonly substate?: RunSubstate;
    readonly interrupted?: boolean;
    readonly waiting?: boolean;
  } = {},
): { readonly statusKey: RunStatusKey; readonly tone: RunStatusTone } {
  let statusKey: RunStatusKey = options.substate ?? status;
  if (options.interrupted) statusKey = 'interrupted';
  else if (options.waiting) statusKey = 'waitingOnUser';
  return { statusKey, tone: RUN_STATUS_TONE_OF[statusKey] };
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
