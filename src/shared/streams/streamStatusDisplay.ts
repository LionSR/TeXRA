import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  StreamPhaseSchema,
  StreamStatusSchema,
  streamStatusToPhase,
  streamStatusToSubstate,
  type StreamPhase,
  type StreamSubstate,
} from '@shared/schemas';

export type StreamStatusDisplayKey = StreamPhase | StreamSubstate | 'ready';

interface StreamStatusDisplayState {
  readonly key?: StreamStatusDisplayKey;
  readonly legacyStatus?: string;
}

function streamStatusDisplayState(
  status: string | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayState {
  if (status == null) return {};
  if (status === STREAM_STATUS.READY) {
    return { key: 'ready' };
  }

  const phase = StreamPhaseSchema.safeParse(status);
  if (phase.success) {
    return { key: substate ?? phase.data };
  }

  const legacyStatus = StreamStatusSchema.safeParse(status);
  if (!legacyStatus.success) return {};

  const legacyPhase = streamStatusToPhase(legacyStatus.data);
  const legacySubstate = streamStatusToSubstate(legacyStatus.data);
  return {
    legacyStatus: legacyStatus.data,
    key: legacySubstate ?? legacyPhase,
  };
}

export function streamStatusDisplayKey(
  status: string | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayKey | undefined {
  return streamStatusDisplayState(status, substate).key;
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
    [STREAM_PHASE.WAITING]: 'Waiting for follow-up',
    [STREAM_SUBSTATE.RESUMING]: 'Resuming',
  },
} as const;

export type StreamStatusLabelStyle = keyof typeof STREAM_STATUS_LABELS;

function legacyStatusLabel(
  status: string | undefined,
  style: StreamStatusLabelStyle,
): string | undefined {
  if (status !== STREAM_STATUS.STOPPED) return undefined;
  return style === 'progressHeader' ? 'Stopped' : 'stopped';
}

// A child/subagent stream suspended at WAITING is stalled awaiting a
// reply-or-stop decision from whoever is looking at it — a different
// situation from the root session's ordinary idle-between-turns WAITING, so
// the CLI styles ('cli'/'cliCompact', which otherwise fold WAITING into the
// root's "idle" wording) use this distinct label instead. `progressHeader`
// already says "Waiting for follow-up" for both root and child, so it needs
// no such split.
const CLI_CHILD_WAITING_LABEL = 'waiting for you';

interface FormatStreamStatusLabelOptions {
  readonly style?: StreamStatusLabelStyle;
  readonly missingLabel?: string;
  readonly substate?: StreamSubstate;
  /** True when `status` belongs to a child/subagent stream rather than the
   *  root session — see `CLI_CHILD_WAITING_LABEL`. */
  readonly isChildStream?: boolean;
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
  const state = streamStatusDisplayState(status, options.substate);
  const style = options.style ?? 'progressHeader';
  const legacyLabel = legacyStatusLabel(state.legacyStatus, style);
  if (legacyLabel) return legacyLabel;
  const key = state.key;
  if (!key) return status;
  if (
    options.isChildStream &&
    key === STREAM_PHASE.WAITING &&
    (style === 'cli' || style === 'cliCompact')
  ) {
    return CLI_CHILD_WAITING_LABEL;
  }
  return STREAM_STATUS_LABELS[style][key] ?? status;
}

/** Compact round/turn progress label: `r2/3` when the planned total is known
 *  (workflow runs), else `r2`. Zero-based `index` renders one-based. */
export function formatRoundStageLabel(stage: {
  readonly index: number;
  readonly total?: number | undefined;
}): string;

export function formatRoundStageLabel(
  stage:
    { readonly index: number; readonly total?: number | undefined } | undefined,
): string | undefined;

export function formatRoundStageLabel(
  stage:
    { readonly index: number; readonly total?: number | undefined } | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  const current = `r${stage.index + 1}`;
  return stage.total !== undefined ? `${current}/${stage.total}` : current;
}
