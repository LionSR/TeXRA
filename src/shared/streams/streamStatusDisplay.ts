import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type PhaseStage,
  type RoundStage,
  type StreamLifecycleStatus,
  type StreamStage,
  type StreamSubstate,
} from '@shared/schemas';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';

export type StreamStatusDisplayKey =
  | Exclude<StreamLifecycleStatus, typeof STREAM_STATUS.READY>
  | StreamSubstate
  | 'ready';

/**
 * Display key for a `StreamLifecycleStatus` (a `StreamPhase`, or the `ready`
 * idle sentinel every host defaults an unstarted stream to).
 */
export function streamStatusDisplayKey(
  status: StreamLifecycleStatus,
  substate?: StreamSubstate,
): StreamStatusDisplayKey;

export function streamStatusDisplayKey(
  status: StreamLifecycleStatus | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayKey | undefined;

export function streamStatusDisplayKey(
  status: StreamLifecycleStatus | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayKey | undefined {
  if (status === undefined) return undefined;
  if (status === STREAM_STATUS.READY) return 'ready';
  return substate ?? status;
}

export function streamStatusIndicatorClass(
  status: StreamLifecycleStatus | undefined,
  substate?: StreamSubstate,
): string | undefined {
  const key = streamStatusDisplayKey(status, substate);
  return key ? `is-${key}` : undefined;
}

// cli and cliCompact share every label except the STARTING ellipsis, so
// cliCompact is derived from cli rather than hand-synced.
const cliStreamStatusLabels: Record<StreamStatusDisplayKey, string> = {
  [STREAM_SUBSTATE.STARTING]: 'starting\u2026',
  [STREAM_PHASE.RUNNING]: 'running',
  [STREAM_PHASE.FAILED]: 'error',
  [STREAM_PHASE.COMPLETED]: 'completed',
  [STREAM_PHASE.CANCELLED]: 'stopped',
  ready: 'ready',
  [STREAM_PHASE.WAITING]: 'idle',
  [STREAM_SUBSTATE.RESUMING]: 'resuming',
} as const;

const STREAM_STATUS_LABELS = {
  cli: cliStreamStatusLabels,
  cliCompact: {
    ...cliStreamStatusLabels,
    [STREAM_SUBSTATE.STARTING]: 'starting',
  },
  progressHeader: {
    [STREAM_SUBSTATE.STARTING]: 'Initializing',
    [STREAM_PHASE.RUNNING]: 'Running',
    [STREAM_PHASE.FAILED]: 'Error',
    [STREAM_PHASE.COMPLETED]: 'Completed',
    [STREAM_PHASE.CANCELLED]: 'Stopped',
    ready: 'Ready',
    [STREAM_PHASE.WAITING]: 'Idle',
    [STREAM_SUBSTATE.RESUMING]: 'Resuming',
  },
} as const;

export type StreamStatusLabelStyle = keyof typeof STREAM_STATUS_LABELS;

interface FormatStreamStatusLabelOptions {
  readonly style?: StreamStatusLabelStyle;
  readonly missingLabel?: string;
  readonly substate?: StreamSubstate;
}

export function formatStreamStatusLabel(
  status: StreamLifecycleStatus | undefined,
  options: FormatStreamStatusLabelOptions & { readonly missingLabel: string },
): string;

export function formatStreamStatusLabel(
  status: StreamLifecycleStatus,
  options?: FormatStreamStatusLabelOptions,
): string;

export function formatStreamStatusLabel(
  status: StreamLifecycleStatus | undefined,
  options?: FormatStreamStatusLabelOptions,
): string | undefined;

export function formatStreamStatusLabel(
  status: StreamLifecycleStatus | undefined,
  options: FormatStreamStatusLabelOptions = {},
): string | undefined {
  if (status === undefined) return options.missingLabel;
  const style = options.style ?? 'progressHeader';
  const key = streamStatusDisplayKey(status, options.substate);
  return STREAM_STATUS_LABELS[style][key];
}

/**
 * One-stop label + display-key derivation for the progress-header style.
 * `formatStreamStatusLabel(..., { style: 'progressHeader' })` and
 * `streamStatusDisplayKey` are the same status→vocabulary lookup seen from
 * two sides (a label and the key that drives icon/state styling), so callers
 * that need both compute them together instead of double-parsing the status.
 */
export function progressHeaderStatus(
  status: StreamLifecycleStatus | undefined,
  substate?: StreamSubstate,
): {
  label: string | undefined;
  displayKey: StreamStatusDisplayKey | undefined;
} {
  const displayKey = streamStatusDisplayKey(status, substate);
  const label = displayKey
    ? STREAM_STATUS_LABELS.progressHeader[displayKey]
    : status;
  return { label, displayKey };
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
  stage: Readonly<StreamStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  if (stage.kind === 'round') return formatRoundStageLabel(stage);
  return formatPhaseStageLabel(stage);
}
