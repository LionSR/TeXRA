/**
 * A run's questions to a person, as rows: what the
 * session's approval policy settles when a request opens, decided in core so
 * that `yolo` and `never` mean one thing on every host; `ask`, which opens a
 * request with that answer beside it and waits for the `request.decided`
 * that closes it, cancelling it on an interruption so no pending request
 * outlives the call; and `decide`, the one writer of a decision. The answer is
 * recorded as the `request.decided` row beside the request's own
 * `request.opened`, in the same batch, so no surface ever lists it pending.
 *
 * A command, an edit and a delegation proposal reach the door already
 * decided by `sessionPermission` (`loop/toolGuard.ts`), so they present.
 */

import {
  Cause,
  Context,
  Effect,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { runStateAppend } from '@shared/session/runHistory';
import { RUN_ROW_READS, runRowsFrom } from '@shared/session/runRows';

import {
  resolveBypass,
  runPolicy,
  withUnborn,
} from '@shared/approvalBypassKind';
import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideApproval,
  isApprovalDenied,
  humanInputDenialMessage,
  retryDenialMessage,
  type ApprovalPolicyDecision,
  type ApprovalPolicyDenial,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  decisionFits,
  qualifyAggregateId,
  isCredentialRetryFailure,
  type CommitOrdinal,
  type DecisionOf,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runState';
import type { Append } from '@shared/session/sessionEvents';
import type { ToolStep } from '@tools/sessionTools';

import { HostCapabilities, type StepToolInputs } from './agentToolResolution';
import { RunCall } from './RunCall';
import type { AgentRunShape } from './run/AgentRun';
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

/** The policy's answer for a run's approval-gated tools under what the
 *  host can answer: whether a step withholds them, and the `permission_mode`
 *  a plugin hook is told. */
export const executableDecision = (
  session: SessionHandle,
  runId: RunId,
  policy = session.approvals.policy(runId),
  // A run whose delegated work is bypassed (an Auto-approve launch) is
  // asked nothing: every approval it would open is granted.
  scopedBypass = session.approvals.bypass(runId, 'superYolo') !== null,
): ApprovalPolicyDecision =>
  decideApproval({
    policy,
    promptRequired: true,
    scopedBypass,
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
  hook: 'allow' | 'ask' | undefined,
):
  | {
      readonly decision: RequestDecision;
      readonly denial?: ApprovalPolicyDenial;
    }
  | undefined {
  const policy = session.approvals.policy(runId);
  switch (payload.kind) {
    case 'planApproval': {
      const answer = session.approvals.permission(runId, 'plan', hook);
      if (answer === 'ask') return undefined;
      return { decision: answer === 'allow' ? { action: 'approve' } : answer };
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
          reason: humanInputDenialMessage(decision.deny),
        },
        denial: { kind: 'humanInput', deny: decision.deny, policy },
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
          reason: retryDenialMessage(decision.deny),
        },
        denial: { kind: 'retry', deny: decision.deny, policy },
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
  hook?: 'allow' | 'ask',
): Extract<RunHistoryDraft, { type: 'request.decided' }>[] {
  const answer = answerFor(session, runId, payload, hook);
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

/** Whether a step's approval-gated tools are withheld, read live from its
 *  session's policy, its grants and its host, and the policy read (which a
 *  denial names). A fresh run's opening reads its uncommitted `run.start`. */
export function liveToolGates({
  session,
  runId,
  entry,
}: Pick<AgentRunShape, 'session' | 'runId'> & {
  readonly entry: Pick<AgentRunShape['entry'], 'registration'>;
}): Pick<StepToolInputs, 'approvalPromptsUnavailable'> & {
  readonly policy: ApprovalPolicy;
} {
  const view = SubscriptionRef.getUnsafe(session.view.ref);
  const start = entry.registration?.[0];
  const source =
    start?.type === 'run.start'
      ? withUnborn(view, runId, start.parent?.id ?? null, start.approvalPolicy)
      : view;
  const policy = runPolicy(session.approvals.policy(), source, runId);
  const bypassed = resolveBypass(source, runId, 'superYolo') !== null;
  return {
    approvalPromptsUnavailable: isApprovalDenied(
      executableDecision(session, runId, policy, bypassed),
    ),
    policy,
  };
}

/** What the session's host serves now: the union of what each plugin of
 *  the step's capability-gated tools says (`HostCapabilities`), each read
 *  from its own services; none without one. */
export const hostCapabilitiesOf = (
  session: SessionHandle,
  step: ToolStep,
  scope: Scope.Scope,
): Effect.Effect<ReadonlySet<string>> => {
  const serving = new Set(
    [...step.entries.values()].flatMap(({ tool, plugin }) =>
      tool.hostCapability === undefined ? [] : [plugin],
    ),
  );
  return Effect.map(
    Effect.forEach(serving, (plugin) =>
      Scope.provide(step.services(new Set([plugin])), scope).pipe(
        Effect.map((services) =>
          Option.match(Context.getOption(services, HostCapabilities), {
            onNone: () => [],
            onSome: ({ of }) => [...of(session.roots.storage)],
          }),
        ),
      ),
    ),
    (served) => new Set(served.flat()),
  );
};

const CHANNEL = 'requestPolicy';

/** What a session's asks are built over. */
export interface RequestAsksInit {
  /** The session the requests are asked on, resolved when first used. */
  readonly session: () => SessionHandle;
  /** Whether the session's doors are shut: a cancellation then writes
   *  nothing. */
  readonly closed: () => boolean;
}

/** A recorded decision, as its request's kind takes it: a surface's answer
 *  is checked before it is recorded and the runtime's own writers use only
 *  actions the kind takes, so any other is a defect. */
export const recordedDecision = <K extends PermissionPayload['kind']>(
  kind: K,
  decision: RequestDecision,
): Effect.Effect<DecisionOf<K>> =>
  decisionFits(kind, decision)
    ? Effect.succeed(decision)
    : Effect.die(
        new Error(
          `A ${kind} request was recorded as answered with "${decision.action}", which it does not take.`,
        ),
      );

/** Build one session's {@link SessionRequests} `ask`, `decide` and
 *  `decision`. */
export function requestAsks({
  session,
  closed,
}: RequestAsksInit): Pick<SessionRequests, 'ask' | 'decide' | 'decision'> {
  const decide: SessionRequests['decide'] = (runId, requestId, answer) =>
    session().log.transact((tx) =>
      decisionRow(runId, requestId, answer, tx.append),
    );

  /** The `request.decided` row for `requestId`, if the request is still
   *  open: the body of one publisher transaction, whether a surface or an
   *  interrupted {@link ask} decides it. It reads the run's
   *  request rows alone, through the type index, so a decision costs the
   *  same however long the run's history grows, and asks `runRowsFrom`
   *  whether the request is open, as the run state does. */
  const decisionRow = (
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
    append: Append,
  ) =>
    Effect.gen(function* () {
      const aggregateId = qualifyAggregateId('run', runId);
      const rows = yield* session().log.rows(
        aggregateId,
        RUN_ROW_READS.requests,
      );
      if (runRowsFrom(rows).requests[requestId]?.decision !== null)
        return false;
      yield* runStateAppend(append)([
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

  const ask = <P extends PermissionPayload, E = never>(
    runId: RunId,
    payload: P,
    options: AskOptions<E> = {},
  ): Effect.Effect<DecisionOf<P['kind']>, LogWriteError | E> => {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    const open: (
      opened: readonly RequestRow[],
    ) => Effect.Effect<CommitOrdinal, E | LogWriteError> =
      options.open ??
      ((opened) =>
        Effect.suspend(() => {
          const from = session().log.now();
          return session()
            .log.transact((tx) => runStateAppend(tx.append)(opened))
            .pipe(Effect.as(from));
        }));
    return Effect.gen(function* () {
      const rows: RequestRow[] = [
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload,
        },
        ...policyDecidedRows(session(), runId, payload, (yield* RunCall)?.hook),
      ];
      const from = yield* open(rows);
      return yield* decision(runId, requestId, from).pipe(
        Effect.flatMap((row) =>
          recordedDecision<P['kind']>(payload.kind, row.decision),
        ),
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
      // The interruption decides the request through the one door a
      // decision takes, awaited: the stop settles with the cancel written.
      Effect.onInterrupt(() =>
        closed()
          ? Effect.void
          : decide(runId, requestId, {
              action: 'cancel',
              cause: 'Run interrupted.',
            }).pipe(
              // `false` is the interruption that landed before the open
              // committed: no row exists, so this cancellation writes none.
              Effect.asVoid,
              // A session draining under it refuses even as a defect.
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `Request ${requestId} was not cancelled as its run stopped`,
                ).pipe(
                  Effect.annotateLogs({ data: Cause.squash(cause) }),
                  withLogChannel(CHANNEL),
                ),
              ),
            ),
      ),
    );
  };

  return { ask, decide, decision };
}
