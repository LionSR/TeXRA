import {
  previewLabel,
  truncateSummary,
  type RunId,
  type RequestDecision,
} from '@texra-ai/harness/schemas';
import { Effect } from 'effect';
/**
 * The inquiry's side of a `request.decided`: an inquiry
 * is a request whose thread names its predecessor, so it rides the one
 * request protocol; what stays here is what is specific to the kind. The
 * answer is recorded on the thread's cross-project record before the
 * decision commits (the record stays, cross-project scope is a real
 * difference, and no session transaction reaches it) and, because an
 * inquiry never makes its run wait, delivered to that run as a `[inquiry]`
 * follow-up that commits with the decision: "a `request.decided` for a
 * request its run is not waiting on is delivered as a follow-up".
 */

// Local imports - agent

// Local imports - shared
import {
  InquiryRecords,
  inquiryThreadFact,
  type InquiryRequest,
  type InquiryThreadId,
  type InquiryThreadRecord,
  type InquiryThreadSummary,
  type InquiryTurnOutcome,
} from '@texra/shared/plugins/externalInquiry';
import {
  type RequestDecisionRecord,
  withLogChannel,
} from '@texra-ai/harness/plugins';

const CHANNEL = 'InquiryTool';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function formatStillOpen(threads: InquiryThreadSummary[]): string[] {
  if (!threads.length) return [];
  return [
    '',
    'Still open on this run:',
    ...threads.map(
      (t) =>
        `  - ${t.threadId}  "${previewLabel(t.lastQuestionPreview)}"  (dispatched ${t.lastActivityIso})`,
    ),
  ];
}

/** The `[inquiry]` follow-up the agent reads: the answer, or the drop. */
function buildContinuationText(params: {
  event: 'answered' | 'dropped';
  threadId: InquiryThreadId;
  question: string;
  answer?: string;
  stillOpen: InquiryThreadSummary[];
}): string {
  const { event, threadId, question, answer, stillOpen } = params;
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
      lines.push('', 'No other open inquiries on this run.');
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
    'Proceed without this answer: either re-formulate (new thread) or take an ' +
      `alternate approach. Do not re-dispatch ${threadId}.`,
  );
  return lines.join('\n');
}

/**
 * Record one inquiry decision on its thread, and say what commits with the
 * decision: the thread's panel row and the continuation the run that asked
 * is sent. The run either drains it at its next turn boundary or resumes
 * from the view (the inbox owns that choice); a run that refuses it has
 * nothing left to continue and the thread is archived as such. A decision
 * for a turn no longer open (a duplicate, a decision after a follow-up
 * reopened the thread) records nothing and sends nothing.
 *
 * The one exception is the turn this decision itself closed on an earlier
 * attempt whose decision then never committed: the thread carries the
 * answer and the request is still pending (the session decides only
 * pending requests), so the continuation is sent from the record rather
 * than reported as already done. Delivery is keyed on the turn, so an
 * attempt whose continuation the queue already holds sends nothing twice.
 */
export const recordInquiryDecision = Effect.fn('recordInquiryDecision')(
  function* (
    permission: InquiryRequest,
    decision: RequestDecision,
  ): Effect.fn.Return<RequestDecisionRecord, Error, InquiryRecords> {
    const records = yield* InquiryRecords;
    const { threadId } = permission;
    const turnIndex = permission.transcript?.at(-1)?.turnIndex ?? 1;
    let outcome: InquiryTurnOutcome;
    let event: 'answered' | 'dropped';
    if (decision.action === 'answer') {
      outcome = yield* records.recordAnswerForOpenTurn({
        threadId,
        turnIndex,
        answer: decision.answer,
        sessionLinks: decision.sessionLinks ?? undefined,
      });
      event = 'answered';
    } else {
      yield* Effect.logInfo(
        `Inquiry ${threadId} dropped (${decision.action})`,
      ).pipe(withLogChannel(CHANNEL));
      outcome = yield* records.markDropped({ threadId, turnIndex });
      event = 'dropped';
    }
    let manifest: InquiryThreadRecord;
    if ('changed' in outcome) {
      manifest = outcome.changed;
    } else {
      // The thread as it stands says why nothing changed: closed at this
      // very turn by an earlier attempt, or no longer at this turn.
      const existing = outcome.unchanged;
      const closed =
        existing !== null &&
        existing.status !== 'open' &&
        existing.turns.at(-1)?.turnIndex === turnIndex
          ? existing
          : null;
      if (!closed) {
        yield* Effect.logWarning(
          `Inquiry ${event === 'answered' ? 'answer' : 'drop'} ignored: thread ${threadId} has no open turn ${turnIndex}.`,
        ).pipe(withLogChannel(CHANNEL));
        return { facts: [] };
      }
      // What the thread says is what the run is told: the earlier attempt's
      // record is the decision that stands, whatever this attempt asked for.
      manifest = closed;
      event = closed.status === 'answered' ? 'answered' : 'dropped';
      yield* Effect.logInfo(
        `Inquiry ${threadId}: re-delivering the ${event} continuation for turn ${turnIndex}, recorded by an attempt that never delivered it.`,
      ).pipe(withLogChannel(CHANNEL));
    }
    // The Background Tasks panel's row for the thread, as it stands: the
    // thread record is the authority, so the session refusing the row is
    // logged, never the decision's failure.
    const summary = yield* records.getThreadSummary(threadId);
    const facts = summary ? [inquiryThreadFact(summary)] : [];
    const lastTurn = manifest.turns.at(-1);
    const parentRunId: RunId | null | undefined = manifest.parentRunId;
    if (!lastTurn || parentRunId == null) return { facts };
    const stillOpen = yield* records.listThreadsByStatus({
      status: 'open',
      scope: 'run',
      runId: parentRunId,
    });
    const text = buildContinuationText({
      event,
      threadId,
      question: lastTurn.question,
      answer:
        event === 'answered' && lastTurn.kind === 'answered'
          ? lastTurn.answer
          : undefined,
      stillOpen,
    });
    // Keyed on the turn: the queue admits one continuation per inquiry turn,
    // so re-delivering after a failure the queue never saw reaches the run
    // and re-delivering after one it did is a no-op.
    return {
      facts,
      followUp: {
        runId: parentRunId,
        item: {
          text,
          from: { kind: 'user' },
          deliveryId: `inquiry:${threadId}:${lastTurn.turnIndex}`,
        },
      },
    };
  },
);
