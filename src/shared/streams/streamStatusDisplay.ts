import { STREAM_STATUS } from '@shared/schemas';

const STREAM_STATUS_LABELS = {
  cli: {
    [STREAM_STATUS.INITIALIZING]: 'starting\u2026',
    [STREAM_STATUS.RUNNING]: 'running',
    [STREAM_STATUS.ERROR]: 'error',
    [STREAM_STATUS.STOPPED]: 'stopped',
    [STREAM_STATUS.READY]: 'ready',
    [STREAM_STATUS.WAITING]: 'idle',
    [STREAM_STATUS.RESUMING]: 'resuming',
  },
  cliCompact: {
    [STREAM_STATUS.INITIALIZING]: 'starting',
    [STREAM_STATUS.RUNNING]: 'running',
    [STREAM_STATUS.ERROR]: 'error',
    [STREAM_STATUS.STOPPED]: 'stopped',
    [STREAM_STATUS.READY]: 'ready',
    [STREAM_STATUS.WAITING]: 'idle',
    [STREAM_STATUS.RESUMING]: 'resuming',
  },
  progressHeader: {
    [STREAM_STATUS.INITIALIZING]: 'Initializing',
    [STREAM_STATUS.RUNNING]: 'Running',
    [STREAM_STATUS.ERROR]: 'Error',
    [STREAM_STATUS.STOPPED]: 'Stopped',
    [STREAM_STATUS.READY]: 'Ready',
    [STREAM_STATUS.WAITING]: 'Waiting for follow-up',
    [STREAM_STATUS.RESUMING]: 'Resuming',
  },
} as const;

export type StreamStatusLabelStyle = keyof typeof STREAM_STATUS_LABELS;

export function formatStreamStatusLabel(
  status: string | undefined,
  options: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel: string;
  },
): string;

export function formatStreamStatusLabel(
  status: string,
  options?: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
  },
): string;

export function formatStreamStatusLabel(
  status: string | undefined,
  options?: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
  },
): string | undefined;

export function formatStreamStatusLabel(
  status: string | undefined,
  options: {
    readonly style?: StreamStatusLabelStyle;
    readonly missingLabel?: string;
  } = {},
): string | undefined {
  if (status == null) return options.missingLabel;
  return (
    STREAM_STATUS_LABELS[options.style ?? 'progressHeader'][
      status as keyof (typeof STREAM_STATUS_LABELS)['progressHeader']
    ] ?? status
  );
}
