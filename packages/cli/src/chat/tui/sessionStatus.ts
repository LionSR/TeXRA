import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';
import { truncateSummary } from '@utils/text/stringUtils';

const QUEUED_FOLLOW_UP_STATUS_LENGTH = 160;

export interface CliSessionStatusInput {
  readonly agent: string;
  readonly model: string;
  readonly api: string;
  readonly approval: string;
  readonly status: string;
  readonly queuedFollowUpMessages: readonly string[];
}

export function readQueuedFollowUpMessagesForStatus(
  streamId: StreamTabId | undefined,
): string[] {
  return streamId === undefined ? [] : ToolUseFollowUpQueue.getAll(streamId);
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
    `agent: ${input.agent}`,
    `model: ${input.model}`,
    `api: ${input.api}`,
    `approval: ${input.approval}`,
    `status: ${input.status}`,
    ...queuedFollowUpStatusLines(input.queuedFollowUpMessages),
  ].join('\n');
}
