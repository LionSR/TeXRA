import {
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  type RunLifecycleStatus,
  type RunSubstate,
} from '@shared/schemas';

/**
 * The tone: a fact-only word every host paints in its own colour vocabulary.
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
 * The one status table: each way a run's status reads, and its tone.
 * A key is the run's phase, its substate when it has one, `ready` before
 * its first activation, or one of the fold's two readings: `interrupted`
 * (an in-flight run whose owner process nobody holds) and `waitingOnUser`
 * (a run parked on the user's answer). The words are the app's; the fold
 * stores the key.
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
 * The status key and tone a `RunView` carries, read from the one
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
