import {
  STREAM_LIFECYCLE_UNAVAILABLE,
  STREAM_PHASE,
  STREAM_LIFECYCLE_READY,
  STREAM_SUBSTATE,
  type PhaseStage,
  type RoundStage,
  type RunLifecycleStatus,
  type RunStage,
  type RunSubstate,
} from '@shared/schemas';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import type { RunGroup } from '@shared/session/sessionView';

export type RunStatusDisplayKey =
  | Exclude<RunLifecycleStatus, typeof STREAM_LIFECYCLE_READY>
  | RunSubstate
  | 'ready';

/**
 * The fold's interrupted reading (PRD one-fold-three-renderers, 5.2): an
 * in-flight run whose owner process nobody holds. A copy key over the
 * durable phase, never a lifecycle status or a host display key, so the
 * durable event set and the hosts' per-status tables stay what they are and
 * only the label and tone change.
 */
const STREAM_DISPLAY_INTERRUPTED = 'interrupted';
type StreamStatusCopyKey =
  RunStatusDisplayKey | typeof STREAM_DISPLAY_INTERRUPTED;

/**
 * Display key for a `StreamLifecycleStatus` (a `StreamPhase`, or the `ready`
 * idle sentinel every host defaults an unstarted stream to).
 */
function streamStatusDisplayKey(
  status: RunLifecycleStatus,
  substate?: RunSubstate,
): RunStatusDisplayKey;

function streamStatusDisplayKey(
  status: RunLifecycleStatus | undefined,
  substate?: RunSubstate,
): RunStatusDisplayKey | undefined;

function streamStatusDisplayKey(
  status: RunLifecycleStatus | undefined,
  substate?: RunSubstate,
): RunStatusDisplayKey | undefined {
  if (status === undefined) return undefined;
  if (status === STREAM_LIFECYCLE_READY) return 'ready';
  return substate ?? status;
}

/**
 * The one status label table (PRD one-fold-three-renderers, G4): the fold
 * reads it into `StreamView.statusLabel`, and every renderer prints that
 * word as is. `packages/cli/scripts/validate-run.mjs` pins the completed and
 * stopped words from here against the real headless run.
 */
const STREAM_STATUS_LABELS: Record<StreamStatusCopyKey, string> = {
  [STREAM_SUBSTATE.STARTING]: 'Initializing',
  [STREAM_PHASE.RUNNING]: 'Running',
  [STREAM_PHASE.FAILED]: 'Error',
  [STREAM_PHASE.COMPLETED]: 'Completed',
  [STREAM_PHASE.CANCELLED]: 'Stopped',
  ready: 'Ready',
  [STREAM_PHASE.WAITING]: 'Idle',
  [STREAM_SUBSTATE.RESUMING]: 'Resuming',
  [STREAM_LIFECYCLE_UNAVAILABLE]: 'Unavailable',
  [STREAM_DISPLAY_INTERRUPTED]: 'Interrupted',
};

/**
 * The one status-to-tone mapping (PRD one-fold-three-renderers, G4 and 15):
 * a fact-only word every host paints in its own colour vocabulary. Keyed by
 * the same display key as the labels above, so a status that gains a label
 * must gain a tone in the same edit.
 */
export const STREAM_STATUS_TONE = {
  RUNNING: 'running',
  SUCCESS: 'success',
  DANGER: 'danger',
  NEUTRAL: 'neutral',
  WARNING: 'warning',
} as const;
type StreamStatusTone =
  (typeof STREAM_STATUS_TONE)[keyof typeof STREAM_STATUS_TONE];

const STREAM_STATUS_TONES: Record<StreamStatusCopyKey, StreamStatusTone> = {
  [STREAM_SUBSTATE.STARTING]: STREAM_STATUS_TONE.RUNNING,
  [STREAM_PHASE.RUNNING]: STREAM_STATUS_TONE.RUNNING,
  [STREAM_PHASE.FAILED]: STREAM_STATUS_TONE.DANGER,
  [STREAM_PHASE.COMPLETED]: STREAM_STATUS_TONE.SUCCESS,
  [STREAM_PHASE.CANCELLED]: STREAM_STATUS_TONE.NEUTRAL,
  ready: STREAM_STATUS_TONE.NEUTRAL,
  [STREAM_PHASE.WAITING]: STREAM_STATUS_TONE.NEUTRAL,
  [STREAM_SUBSTATE.RESUMING]: STREAM_STATUS_TONE.RUNNING,
  [STREAM_LIFECYCLE_UNAVAILABLE]: STREAM_STATUS_TONE.WARNING,
  [STREAM_DISPLAY_INTERRUPTED]: STREAM_STATUS_TONE.WARNING,
};

/**
 * The label and tone pair a `StreamView` carries (G4), read from the one
 * table through one display key: the status and substate, or the fold's
 * interrupted reading when an in-flight run has lost its owner.
 */
export function streamStatusCopy(
  status: RunLifecycleStatus,
  options: {
    readonly substate?: RunSubstate;
    readonly interrupted?: boolean;
  } = {},
): { readonly statusLabel: string; readonly tone: StreamStatusTone } {
  const key = options.interrupted
    ? STREAM_DISPLAY_INTERRUPTED
    : streamStatusDisplayKey(status, options.substate);
  return {
    statusLabel: STREAM_STATUS_LABELS[key],
    tone: STREAM_STATUS_TONES[key],
  };
}

/** Banner copy for the fold's interrupted reading: the process running the
 *  run is gone; a pending approval stays listed, so a resume re-asks it. */
export function streamInterruptedMessage(): string {
  return 'The process running this run stopped before it finished. Resume it to continue.';
}

/** Banner and tooltip copy for a run another TeXRA process holds, named by
 *  its pid: the one part of a process identity a user can act on. */
export function streamHeldMessage(pid: number): string {
  return `Held by another TeXRA process (pid ${pid}). Let it finish or close it; if it is gone, Delete removes the run.`;
}

/** Banner and tooltip copy for a run whose saved state could not be read. */
export function streamUnreadableMessage(cause: string): string {
  return `Could not read this run's state: ${cause}. Delete removes it.`;
}

interface FormatStreamStatusLabelOptions {
  readonly missingLabel?: string;
  readonly substate?: RunSubstate;
}

export function formatRunStatusLabel(
  status: RunLifecycleStatus | undefined,
  options: FormatStreamStatusLabelOptions & { readonly missingLabel: string },
): string;

export function formatRunStatusLabel(
  status: RunLifecycleStatus,
  options?: FormatStreamStatusLabelOptions,
): string;

export function formatRunStatusLabel(
  status: RunLifecycleStatus | undefined,
  options?: FormatStreamStatusLabelOptions,
): string | undefined;

export function formatRunStatusLabel(
  status: RunLifecycleStatus | undefined,
  options: FormatStreamStatusLabelOptions = {},
): string | undefined {
  if (status === undefined) return options.missingLabel;
  return STREAM_STATUS_LABELS[streamStatusDisplayKey(status, options.substate)];
}

/**
 * One-stop label + display-key derivation. `formatStreamStatusLabel` and
 * `streamStatusDisplayKey` are the same status→vocabulary lookup seen from
 * two sides (a label and the key that drives icon/state styling), so callers
 * that need both compute them together instead of double-parsing the status.
 */
export function progressHeaderStatus(
  status: RunLifecycleStatus | undefined,
  substate?: RunSubstate,
): {
  label: string | undefined;
  displayKey: RunStatusDisplayKey | undefined;
} {
  return {
    label: formatRunStatusLabel(status, { substate }),
    displayKey: streamStatusDisplayKey(status, substate),
  };
}

/** Compact round/turn progress label: `r2/3` when the planned total is known
 *  (workflow runs), else `r2`. Zero-based `index` renders one-based. */
export function formatRoundStageLabel(stage: Readonly<RoundStage>): string;

export function formatRoundStageLabel(
  stage: Readonly<RoundStage> | undefined,
): string | undefined;

export function formatRoundStageLabel(
  stage: Readonly<RoundStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  const current = `r${stage.index + 1}`;
  return stage.total !== undefined ? `${current}/${stage.total}` : current;
}

/** Phase progress label for a workflow-script run, spelled by the one owner of
 *  phase heading copy so this slot cannot drift from the transcript divider and
 *  the run-status band that render beside it. Occupies the same row slot as
 *  `formatRoundStageLabel` — a run opens phases or rounds, never both. */
export function formatPhaseStageLabel(
  stage: Readonly<PhaseStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  return formatWorkflowPhaseHeading({
    phaseLabel: stage.label,
    phaseIndex: stage.index,
    phaseTotal: stage.total,
  });
}

/** Label for the one stage slot a stream fills: a workflow-script run advances
 *  through named phases, a tool-use run through numbered rounds, never both,
 *  so every surface that shows the slot dispatches on the same discriminant. */
export function formatStageLabel(
  stage: Readonly<RunStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  if (stage.kind === 'round') return formatRoundStageLabel(stage);
  return formatPhaseStageLabel(stage);
}

/**
 * One section per `group` arm, and the order the sections are painted in.
 * Both surfaces that group a stream list — the webview tab strip and the
 * TUI's stream tree — read this table rather than spelling the four labels
 * again, so a renamed section cannot say one thing in the dock and another
 * in the terminal.
 *
 * Deep-frozen: the record crosses a module boundary into two renderers, and
 * `readonly` is compile-time only.
 */
export const STREAM_GROUP_LABELS: Readonly<Record<RunGroup, string>> =
  Object.freeze({
    running: 'Running',
    waiting: 'Waiting on you',
    interrupted: 'Interrupted',
    recent: 'Recent',
  });

/** Section order, in the group union's own order. */
export const STREAM_GROUP_ORDER: readonly RunGroup[] = Object.freeze(
  Object.keys(STREAM_GROUP_LABELS) as RunGroup[],
);
