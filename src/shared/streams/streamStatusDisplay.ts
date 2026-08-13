import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  StreamPhaseSchema,
  type PhaseStage,
  type RoundStage,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
} from '@shared/schemas';

export type StreamStatusDisplayKey = StreamPhase | StreamSubstate | 'ready';

/**
 * Display key for a `StreamLifecycleStatus` (a `StreamPhase`, or the `ready`
 * idle sentinel every host defaults an unstarted stream to). Anything else —
 * including the retired 7-value `StreamStatus` vocabulary, which no live
 * producer emits and which every read boundary normalizes before it reaches a
 * renderer — has no key, and callers fall back to showing the raw string.
 */
export function streamStatusDisplayKey(
  status: string | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayKey | undefined {
  if (status === STREAM_STATUS.READY) return 'ready';
  const phase = StreamPhaseSchema.safeParse(status);
  if (!phase.success) return undefined;
  return substate ?? phase.data;
}

export function streamStatusIndicatorClass(
  status: string | undefined,
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
  status: string | undefined,
  options: FormatStreamStatusLabelOptions & { readonly missingLabel: string },
): string;

export function formatStreamStatusLabel(
  status: string,
  options?: FormatStreamStatusLabelOptions,
): string;

export function formatStreamStatusLabel(
  status: string | undefined,
  options?: FormatStreamStatusLabelOptions,
): string | undefined;

export function formatStreamStatusLabel(
  status: string | undefined,
  options: FormatStreamStatusLabelOptions = {},
): string | undefined {
  if (status == null) return options.missingLabel;
  const style = options.style ?? 'progressHeader';
  const key = streamStatusDisplayKey(status, options.substate);
  if (!key) return status;
  return STREAM_STATUS_LABELS[style][key];
}

/**
 * One-stop label + display-key derivation for the progress-header style.
 * `formatStreamStatusLabel(..., { style: 'progressHeader' })` and
 * `streamStatusDisplayKey` are the same status→vocabulary lookup seen from
 * two sides (a label and the key that drives icon/state styling), so callers
 * that need both compute them together instead of double-parsing the status.
 * A status with no display key (unknown/legacy vocabulary) falls back to the
 * raw string as the label, matching `formatStreamStatusLabel`.
 */
export function progressHeaderStatus(
  status: string | undefined,
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

/** Compact phase progress label for a workflow-script run: `Reduce 2/3` when
 *  the phase was declared with a position and a planned total, `Reduce 2` with
 *  only a position, and the bare title for a dynamically opened phase.
 *  Zero-based `index` renders one-based. Occupies the same row slot as
 *  `formatRoundStageLabel` — a run opens phases or rounds, never both. */
export function formatPhaseStageLabel(
  stage: Readonly<PhaseStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  if (stage.index === undefined) return stage.label;
  const current = `${stage.label} ${stage.index + 1}`;
  return stage.total !== undefined ? `${current}/${stage.total}` : current;
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
