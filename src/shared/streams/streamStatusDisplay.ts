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

export interface StreamStatusDisplayState {
  readonly phase?: StreamPhase;
  readonly substate?: StreamSubstate;
  readonly key?: StreamStatusDisplayKey;
  readonly legacyStatus?: string;
}

function phaseDisplayKey(phase: StreamPhase): StreamStatusDisplayKey {
  return phase;
}

export function streamStatusDisplayState(
  status: string | undefined,
  substate?: StreamSubstate,
): StreamStatusDisplayState {
  if (status == null) return {};
  if (status === STREAM_STATUS.READY) {
    return { key: 'ready' };
  }

  const phase = StreamPhaseSchema.safeParse(status);
  if (phase.success) {
    return {
      phase: phase.data,
      ...(substate ? { substate } : {}),
      key: substate ?? phaseDisplayKey(phase.data),
    };
  }

  const legacyStatus = StreamStatusSchema.safeParse(status);
  if (!legacyStatus.success) return {};

  const legacyPhase = streamStatusToPhase(legacyStatus.data);
  const legacySubstate = streamStatusToSubstate(legacyStatus.data);
  return {
    phase: legacyPhase,
    ...(legacySubstate ? { substate: legacySubstate } : {}),
    legacyStatus: legacyStatus.data,
    key: legacySubstate ?? phaseDisplayKey(legacyPhase),
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

export function formatStreamStatusLabel(
  status: string | undefined,
  options: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel: string;
    readonly substate?: StreamSubstate;
  },
): string;

export function formatStreamStatusLabel(
  status: string,
  options?: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
    readonly substate?: StreamSubstate;
  },
): string;

export function formatStreamStatusLabel(
  status: string | undefined,
  options?: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
    readonly substate?: StreamSubstate;
  },
): string | undefined;

export function formatStreamStatusLabel(
  status: string | undefined,
  options: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
    readonly substate?: StreamSubstate;
  } = {},
): string | undefined {
  if (status == null) return options.missingLabel;
  const state = streamStatusDisplayState(status, options.substate);
  const legacyLabel = legacyStatusLabel(
    state.legacyStatus,
    options.style ?? 'progressHeader',
  );
  if (legacyLabel) return legacyLabel;
  const key = state.key;
  if (!key) return status;
  return STREAM_STATUS_LABELS[options.style ?? 'progressHeader'][key] ?? status;
}
