import type {
  ExternalInquiryThreadId,
  ExternalInquiryThreadSummary,
} from '@shared/schemas';
import { formatRelativeTime } from '@shared/utils/string';
import { truncateSummary, truncateWithEllipsis } from '@utils/text/stringUtils';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

export interface ExternalInquiryContinuationTextRequest {
  readonly event: 'answered' | 'dropped';
  readonly threadId: ExternalInquiryThreadId;
  readonly question: string;
  readonly answer?: string;
  readonly stillOpen: readonly ExternalInquiryThreadSummary[];
}

function formatStillOpen(
  threads: readonly ExternalInquiryThreadSummary[],
): string[] {
  if (!threads.length) return [];
  const lines = ['', 'Still open on this stream:'];
  for (const thread of threads) {
    const since = formatRelativeTime(Date.parse(thread.lastActivityIso));
    lines.push(
      `  - ${thread.threadId}  "${truncateWithEllipsis(
        thread.lastQuestionPreview,
        60,
      )}"  (dispatched ${since})`,
    );
  }
  return lines;
}

export function buildExternalInquiryContinuationText({
  event,
  threadId,
  question,
  answer,
  stillOpen,
}: ExternalInquiryContinuationTextRequest): string {
  const lines: string[] = [];

  if (event === 'answered') {
    lines.push(`[inquiry] ${threadId} answered.`);
    lines.push(`Q: ${truncateSummary(question, QUESTION_TRUNCATION)}`);
    if (answer !== undefined) {
      lines.push(
        `A: ${truncateSummary(answer, ANSWER_TRUNCATION)}` +
          (answer.length > ANSWER_TRUNCATION
            ? ` (full text available in thread ${threadId})`
            : ''),
      );
    }
    lines.push(`Full thread: ${threadId}`);
    lines.push(...formatStillOpen(stillOpen));
    if (stillOpen.length === 0) {
      lines.push('', 'No other open inquiries on this stream.');
    }
    lines.push(
      '',
      stillOpen.length
        ? 'Proceed using the new answer. Do not re-dispatch any open thread_id.'
        : 'Proceed using the new answer.',
    );
    return lines.join('\n');
  }

  lines.push(`[inquiry] ${threadId} dropped by user.`);
  lines.push(`Q: ${truncateSummary(question, QUESTION_TRUNCATION)}`);
  lines.push(`Full thread: ${threadId}`);
  lines.push(...formatStillOpen(stillOpen));
  lines.push(
    '',
    'Proceed without this answer — either re-formulate (new thread) or take an ' +
      `alternate approach. Do not re-dispatch ${threadId}.`,
  );
  return lines.join('\n');
}
