/**
 * A run's questions to a person, as rows (one run model, 3.7): what the
 * session's approval policy settles when a request opens, decided in core so
 * that `yolo` and `never` mean one thing on every host; `ask`, which opens a
 * request with that answer beside it and waits for the `request.decided`
 * that closes it, cancelling it on an interruption so no pending request
 * outlives the call; and `decide`, the one writer of a decision. The answer is
 * recorded as the `request.decided` row beside the request's own
 * `request.opened`, in the same batch, so no surface ever lists it pending.
 *
 * A command or edit reaches the session's door already decided by its tool,
 * which alone holds the approvals setting and the run's scoped bypass, and a
 * delegation proposal by its flow (`proposalFlow.ts`, `yolo` included); those
 * present.
 */

import { Effect, Option, Stream } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
  type ApprovalPolicyDenial,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  isCredentialRetryFailure,
  type CommitOrdinal,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import type { Append, SessionEventsShape } from '@shared/session/sessionEvents';

import type { StepToolInputs } from './agentToolResolution';
import type {
  AskOptions,
  LogWriteError,
  RequestRow,
  SessionHandle,
  SessionRequests,
} from './SessionHandle';

/** What the session's host can answer, read live: a host attached after a
 *  run started still answers for it. */
const canPresent = (session: SessionHandle): boolean =>
  !session.interactions.approvalPromptsUnavailable;

/**
 * The policy's answer for an executable request (a plan, or any
 * approval-gated tool) under what the host can answer. One reading for
 * every run of the session, whoever triggers it.
 */
const executableDecision = (session: SessionHandle, runId: RunId) =>
  decideTexraApproval({
    policy: session.approvals.policy(runId),
    promptRequired: true,
    scopedBypass: false,
    canPresent: canPresent(session),
  });

/** The policy's answer for one request: a plan follows the executable rule
 *  (`never` denies, `yolo` approves, `ask` presents or, with nobody to ask,
 *  denies), and a question or a retry is denied under `yolo` rather than
 *  answered on a person's behalf. */
function answerFor(
  session: SessionHandle,
  runId: RunId,
  payload: PermissionPayload,
):
  | {
      readonly decision: RequestDecision;
      readonly denial?: ApprovalPolicyDenial;
    }
  | undefined {
  const policy = session.approvals.policy(runId);
  switch (payload.kind) {
    case 'planApproval': {
      const decision = executableDecision(session, runId);
      if (decision === 'present') return undefined;
      if (decision === 'allow') return { decision: { action: 'approve' } };
      return {
        decision: {
          action: 'deny',
          reason: texraApprovalDenialMessage(decision),
        },
        denial: { kind: 'plan' },
      };
    }
    case 'userQuestion': {
      const decision = decideHumanInputRequest({
        policy,
        canPresent: canPresent(session),
      });
      if (decision === 'present') return undefined;
      return {
        decision: {
          action: 'deny',
          reason: texraHumanInputDenialMessage(decision.deny),
        },
        denial: { kind: 'humanInput', deny: decision.deny },
      };
    }
    case 'retry': {
      const decision = decideRetryApproval({
        policy,
        canPresent: canPresent(session),
        isCredentialFailure: isCredentialRetryFailure(
          payload.data.errorDetails,
        ),
      });
      if (decision === 'present') return undefined;
      return {
        decision: {
          action: 'deny',
          reason: texraRetryDenialMessage(decision.deny),
        },
        denial: { kind: 'retry', deny: decision.deny },
      };
    }
    case 'proposal':
    case 'toolEdit':
    case 'bash':
    case 'externalInquiry':
      return undefined;
  }
}

/**
 * The rows that record the policy's answer beside a request about to open:
 * none when a surface decides. A denial is told to the attached host as the
 * request opens.
 */
export function policyDecidedRows(
  session: SessionHandle,
  runId: RunId,
  payload: PermissionPayload,
): Extract<RunHistoryDraft, { type: 'request.decided' }>[] {
  const answer = answerFor(session, runId, payload);
  if (answer === undefined) return [];
  if (answer.denial) session.interactions.approvalDenied(answer.denial, runId);
  return [
    {
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', runId),
      requestId: payload.data.requestId,
      decision: answer.decision,
    },
  ];
}

/** The step's inputs read live from its session: whether approvals can be
 *  asked, and what its host serves now. */
export function liveToolGates(
  session: SessionHandle,
  runId: RunId,
): Pick<StepToolInputs, 'approvalPromptsUnavailable' | 'hostCapabilities'> {
  return {
    approvalPromptsUnavailable: isTexraApprovalDenied(
      executableDecision(session, runId),
    ),
    hostCapabilities: new Set(
      session.interactions.readDiagnostics ? ['diagnostics'] : [],
    ),
  };
}

const CHANNEL = 'requestPolicy';

/** The rows one request's state is read off. */
const REQUEST_TYPES: readonly SessionEvent['type'][] = [
  'request.opened',
  'request.decided',
];

/** What a session's asks are built over. */
export interface RequestAsksInit {
  /** The session the requests are asked on, resolved when first used. */
  readonly session: () => SessionHandle;
  /** The publisher's detached door: an interrupted ask's cancellation. */
  readonly detach: SessionEventsShape['detach'];
  /** Whether the session's doors are shut: a cancellation then writes
   *  nothing. */
  readonly closed: () => boolean;
}

/** Build one session's {@link SessionRequests} `ask`, `decide` and
 *  `decision`. */
export function requestAsks({
  session,
  detach,
  closed,
}: RequestAsksInit): Pick<SessionRequests, 'ask' | 'decide' | 'decision'> {
  /** The `request.decided` row for `requestId`, if the request is still
   *  open: the body of one publisher transaction, whether a surface awaits
   *  it or an interrupted {@link ask} detaches it. It reads the run's
   *  request rows alone, through the type index, so a decision costs the
   *  same however long the run's history grows. */
  const decisionRow = (
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
    append: Append,
  ) =>
    Effect.gen(function* () {
      const aggregateId = qualifyAggregateId('run', runId);
      const rows = yield* session().log.rows(aggregateId, REQUEST_TYPES);
      const mine = rows.filter(
        (row) => 'requestId' in row && row.requestId === requestId,
      );
      if (!mine.some((row) => row.type === 'request.opened')) return false;
      if (mine.some((row) => row.type === 'request.decided')) return false;
      yield* append([
        { type: 'request.decided', aggregateId, requestId, decision },
      ]);
      return true;
    });

  const decision: SessionRequests['decision'] = (runId, requestId, from) => {
    const aggregate = qualifyAggregateId('run', runId);
    return session()
      .log.tail(from)
      .pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<SessionEvent, { type: 'request.decided' }> =>
            event.type === 'request.decided' &&
            event.aggregateId === aggregate &&
            event.requestId === requestId,
        ),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new Error(
                  `The session closed before request ${requestId} was decided.`,
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
  };

  const ask = <E = never>(
    runId: RunId,
    payload: PermissionPayload,
    options: AskOptions<E> = {},
  ): Effect.Effect<RequestDecision, LogWriteError | E> => {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    const releaseUncommitted = Effect.uninterruptible(
      options.onNeverCommitted ?? Effect.void,
    );
    const open: (
      opened: readonly RequestRow[],
    ) => Effect.Effect<CommitOrdinal, E | LogWriteError> =
      options.open ??
      ((opened) =>
        Effect.suspend(() => {
          const from = session().log.now();
          return session().log.transact(opened).pipe(Effect.as(from));
        }));
    return Effect.gen(function* () {
      const rows: RequestRow[] = [
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload,
        },
        ...policyDecidedRows(session(), runId, payload),
      ];
      const from = yield* open(rows).pipe(
        Effect.tapError(() => releaseUncommitted),
      );
      return yield* decision(runId, requestId, from).pipe(
        Effect.map((row) => row.decision),
        Effect.catch((cause) =>
          Effect.logWarning(
            `Request ${requestId} closed without a decision`,
          ).pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel(CHANNEL),
            Effect.as({
              action: 'cancel',
              cause: cause.message,
            } satisfies RequestDecision),
          ),
        ),
      );
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (closed()) return;
          detach((append) =>
            decisionRow(
              runId,
              requestId,
              { action: 'cancel', cause: 'Run interrupted.' },
              append,
            ).pipe(
              // `false` is the interruption that landed before the open
              // committed: no row exists, so this cancellation writes none
              // either and the caller's staging has no decision coming.
              Effect.tap((cancelled) =>
                cancelled ? Effect.void : releaseUncommitted,
              ),
            ),
          );
        }),
      ),
    );
  };

  const decide: SessionRequests['decide'] = (runId, requestId, answer) =>
    session().log.transact((tx) =>
      decisionRow(runId, requestId, answer, tx.append),
    );

  return { ask, decide, decision };
}
