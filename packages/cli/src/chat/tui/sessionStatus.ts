import { STREAM_STATUS } from '@shared/schemas';
import { truncateSummary } from '@utils/text/stringUtils';

const QUEUED_FOLLOW_UP_STATUS_LENGTH = 160;

export interface CliSessionStatusInput {
  readonly agent: string;
  readonly model: string;
  readonly teamName?: string;
  readonly api: string;
  readonly approval: string;
  readonly status: string;
  readonly queuedFollowUpMessages: readonly string[];
}

export function formatCliStatusLabel(status: string | undefined): string {
  switch (status) {
    case STREAM_STATUS.INITIALIZING:
      return 'starting…';
    case STREAM_STATUS.RUNNING:
      return 'running';
    case STREAM_STATUS.WAITING:
      return 'idle';
    case STREAM_STATUS.STOPPED:
      return 'stopped';
    case STREAM_STATUS.READY:
      return 'ready';
    default:
      return status ?? '—';
  }
}

function queuedFollowUpStatusLines(messages: readonly string[]): string[] {
  if (messages.length === 0) return ['queued follow-ups: 0'];

  return [
    `queued follow-ups: ${messages.length}`,
    ...messages.map(
      (message, index) =>
        `${index + 1}. ${truncateSummary(message, QUEUED_FOLLOW_UP_STATUS_LENGTH)}`,
    ),
  ];
}

export function formatCliSessionStatus(input: CliSessionStatusInput): string {
  return [
    ...(input.teamName ? [`team: ${input.teamName}`] : []),
    `agent: ${input.agent}`,
    `model: ${input.model}`,
    `api: ${input.api}`,
    `approval: ${input.approval}`,
    `status: ${formatCliStatusLabel(input.status)}`,
    ...queuedFollowUpStatusLines(input.queuedFollowUpMessages),
  ].join('\n');
}
