/**
 * A run's questions to a person, as rows of the run. A request opens
 * through the run's cell ({@link openRequest}): its `request.opened` and,
 * when the session's policy answers it (a `yolo` or `never` policy, a
 * grant that covers it, nobody to ask), the `request.decided` beside it in
 * the same batch, so no surface ever lists it pending; otherwise the asker
 * waits on the row stream for the decision a surface lands
 * ({@link decisionOf}). Every decision is one checked append
 * ({@link decideRequest}): a surface's answer, a grant change answering
 * the requests it covers, and the invoker's own. A request a stopped or
 * failed run leaves open is cancelled with the run's end, in the end's
 * batch (`endIn`); one a dead process left, with the run's next activation
 * ({@link cancelRequestRows}).
 *
 * A command, an edit and a delegation proposal reach the door already
 * decided by `sessionPermission` (`loop/toolGuard.ts`), so they present.
 */

import {
  Context,
  Effect,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import {
  Approvals,
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { isRequestDecision } from '@shared/session/runRowReads';

import {
  APPROVAL_BYPASS_KINDS,
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
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  bypassCovers,
  decisionFits,
  qualifyAggregateId,
  type CommitOrdinal,
  type DecisionOf,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { RunHistoryDraft } from '@shared/session/runState';
import type { LogWriteError } from '@shared/session/sessionLog';
import type { ToolStep } from '@tools/sessionTools';

import { HostCapabilities, type StepToolInputs } from './agentToolResolution';
import { Interactions } from './HostInteractions';
import type { AgentRunShape } from './run/AgentRun';
import type { SessionRequestsShape } from './SessionHandle';

/** The session's approvals and its presentation host: what the policy's
 *  answers read. */
const policyOwners = Effect.all({
  approvals: Approvals,
  interactions: Interactions,
});
type PolicyOwners = Effect.Success<typeof policyOwners>;

/** The rows that open a request: its `request.opened`, and the
 *  `request.decided` the policy lands beside it. */
export type RequestRow = Extract<
  RunHistoryDraft,
  { type: 'request.opened' | 'request.decided' }
>;
type DecidedDraft = Extract<RequestRow, { type: 'request.decided' }>;

/** What the session's host can answer, read live: a host attached after a
 *  run started still answers for it. */
const canPresent = ({ interactions }: PolicyOwners): boolean =>
  !interactions.approvalPromptsUnavailable;

/** The policy's answer for a run's approval-gated tools under what the
 *  host can answer: whether a step withholds them, and whether the run's
 *  work runs unasked ({@link workAutoApproved}). */
const decideExecutable = (
  owners: PolicyOwners,
  runId: RunId,
  policy = owners.approvals.policy(runId),
  // A run whose delegated work is bypassed (an Auto-approve launch) is
  // asked nothing: every approval it would open is granted.
  scopedBypass = owners.approvals.bypass(runId, 'superYolo') !== null,
): ApprovalPolicyDecision =>
  decideApproval({
    policy,
    scopedBypass,
    canPresent: canPresent(owners),
  });

/** Whether `runId`'s work runs unasked under the session's own policy
 *  ({@link decideExecutable} allows): what a plugin hook's `permission_mode`
 *  and a coding agent's own sandbox or permissions follow. */
export const workAutoApproved = (
  runId: RunId,
): Effect.Effect<boolean, never, Approvals | Interactions> =>
  Effect.map(
    policyOwners,
    (owners) => decideExecutable(owners, runId) === 'allow',
  );

/** Whether a grant the run holds answers a request of `payload`'s kind:
 *  one whose bypass covers the kind, unless the request says only a
 *  person answers it (`allowBypass: false`, a hook's ask). */
const grantAnswers = (
  owners: PolicyOwners,
  runId: RunId,
  payload: PermissionPayload,
): boolean =>
  !('allowBypass' in payload.data && !payload.data.allowBypass) &&
  APPROVAL_BYPASS_KINDS.some(
    (kind) =>
      bypassCovers(kind, payload.kind) &&
      owners.approvals.bypass(runId, kind) !== null,
  );

/** The policy's answer for one request, or undefined when a person
 *  answers: a plan follows the executable rule (`never` denies, `yolo`
 *  approves, `ask` presents or, with nobody to ask, denies); a question or
 *  a retry is denied under `yolo` rather than answered on a person's
 *  behalf; a command, an edit or a proposal a grant covers is approved. */
function answerFor(
  owners: PolicyOwners,
  runId: RunId,
  payload: PermissionPayload,
  hook: 'allow' | 'ask' | undefined,
): RequestDecision | undefined {
  const policy = owners.approvals.policy(runId);
  switch (payload.kind) {
    case 'planApproval': {
      const answer = owners.approvals.permission(runId, 'plan', hook);
      if (answer === 'ask') return undefined;
      return answer === 'allow' ? { action: 'approve' } : answer;
    }
    case 'userQuestion': {
      const decision = decideHumanInputRequest({
        policy,
        canPresent: canPresent(owners),
      });
      if (decision === 'present') return undefined;
      return {
        action: 'deny',
        reason: humanInputDenialMessage(decision.deny),
      };
    }
    case 'retry': {
      const decision = decideRetryApproval({
        policy,
        canPresent: canPresent(owners),
        isCredentialFailure: payload.data.credentialSwitch != null,
      });
      if (decision === 'present') return undefined;
      return { action: 'deny', reason: retryDenialMessage(decision.deny) };
    }
    case 'proposal':
    case 'toolEdit':
    case 'bash':
      return grantAnswers(owners, runId, payload)
        ? { action: 'approve' }
        : undefined;
    case 'plugin':
      return undefined;
  }
}

/** The `request.decided` that records the policy's answer beside a request
 *  about to open: none when a person decides. */
export const policyDecidedRows = (
  runId: RunId,
  payload: PermissionPayload,
  hook?: 'allow' | 'ask',
): Effect.Effect<DecidedDraft[], never, Approvals | Interactions> =>
  Effect.map(policyOwners, (owners) => {
    const decision = answerFor(owners, runId, payload, hook);
    return decision === undefined
      ? []
      : [
          {
            type: 'request.decided',
            aggregateId: qualifyAggregateId('run', runId),
            requestId: payload.data.requestId,
            decision,
          },
        ];
  });

/** Whether a step's approval-gated tools are withheld, read live from its
 *  session's policy, its grants and its host, and the policy read (which a
 *  denial names). A fresh run's opening reads its uncommitted `run.start`. */
export const liveToolGates = Effect.fn('liveToolGates')(function* ({
  runId,
  entry,
}: Pick<AgentRunShape, 'runId'> & {
  readonly entry: Pick<AgentRunShape['entry'], 'registration'>;
}): Effect.fn.Return<
  Pick<StepToolInputs, 'approvalPromptsUnavailable'> & {
    readonly policy: ApprovalPolicy;
  },
  never,
  SessionViewAccess | Approvals | Interactions
> {
  const owners = yield* policyOwners;
  const view = SubscriptionRef.getUnsafe((yield* SessionViewAccess).ref);
  const start = entry.registration?.start ?? null;
  const parent = start?.parent?.id ?? null;
  const source =
    start === null
      ? view
      : withUnborn(view, runId, parent, start.approvalPolicy);
  const policy = runPolicy(owners.approvals.policy(), source, runId);
  const bypassed = resolveBypass(source, runId, 'superYolo') !== null;
  return {
    approvalPromptsUnavailable: isApprovalDenied(
      decideExecutable(owners, runId, policy, bypassed),
    ),
    policy,
  };
});

/** What the session's host serves now: the union of what each plugin of
 *  the step's capability-gated tools says (`HostCapabilities`), each read
 *  from its own services; none without one. */
export const hostCapabilitiesOf = (
  step: ToolStep,
  scope: Scope.Scope,
): Effect.Effect<ReadonlySet<string>, never, SessionRoots> => {
  const serving = new Set(
    [...step.entries.values()].flatMap(({ tool, plugin }) =>
      tool.hostCapability === undefined ? [] : [plugin],
    ),
  );
  return Effect.gen(function* () {
    const { storage } = yield* SessionRoots;
    const served = yield* Effect.forEach(serving, (plugin) =>
      Scope.provide(step.services(new Set([plugin])), scope).pipe(
        Effect.map((services) =>
          Option.match(Context.getOption(services, HostCapabilities), {
            onNone: () => [],
            onSome: ({ of }) => [...of(storage)],
          }),
        ),
      ),
    );
    return new Set(served.flat());
  });
};

const CHANNEL = 'requests';

/** A recorded decision, as its request takes it: a surface's answer is
 *  checked before it is recorded and the runtime's own writers use only
 *  actions the request takes, so any other is a defect. */
export const recordedDecision = <P extends Parameters<typeof decisionFits>[0]>(
  request: P,
  decision: RequestDecision,
): Effect.Effect<DecisionOf<P['kind']>> =>
  decisionFits(request, decision)
    ? Effect.succeed(decision)
    : Effect.die(
        new Error(
          `A ${request.kind} request was recorded as answered with "${decision.action}", which it does not take.`,
        ),
      );

/**
 * Answer a request if it is still open: the one writer of a decision. The
 * check reads the committed rows and the `request.decided` lands in one
 * transaction, so two writers answering at once record exactly one;
 * `false` is that lost race, or an id never opened. It reads the run's
 * request rows alone (the `requests` read, through the type index), so a
 * decision costs the same however long the run's history grows.
 */
export const decideRequest = (
  runId: RunId,
  requestId: string,
  decision: RequestDecision,
): Effect.Effect<boolean, DatabaseReadFailed | LogWriteError, SessionLog> =>
  SessionLog.use((log) =>
    log.transact((tx) =>
      Effect.gen(function* () {
        const aggregateId = qualifyAggregateId('run', runId);
        const { requests } = yield* log.runRows(aggregateId, 'requests');
        if (requests[requestId]?.decision !== null) return false;
        yield* runStateAppend(tx.append)([
          { type: 'request.decided', aggregateId, requestId, decision },
        ]);
        return true;
      }),
    ),
  );

/** The `request.decided` row answering `requestId`, read from the row
 *  stream above `from`: what a run blocked on a request waits for. Fails
 *  when the log closes first, which a waiting caller reads as a
 *  cancellation. */
export const decisionOf = (
  runId: RunId,
  requestId: string,
  from: CommitOrdinal,
): Effect.Effect<
  Extract<SessionEvent, { type: 'request.decided' }>,
  Error,
  SessionLog
> =>
  SessionLog.use((log) => {
    const aggregate = qualifyAggregateId('run', runId);
    return log.tail(from).pipe(
      Stream.filter(isRequestDecision),
      Stream.filter(
        (event) =>
          event.aggregateId === aggregate && event.requestId === requestId,
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
  });

/** How {@link openRequest} commits its rows: through the asker's cell,
 *  answering the commit its decision is read from. */
export interface RequestOpening<E> {
  /** Commit the request's rows (the `request.opened` and the policy's
   *  answer beside it; a re-entered request's answer alone). */
  readonly commit: (
    rows: readonly RequestRow[],
  ) => Effect.Effect<CommitOrdinal, E>;
  /** The strings the payload names by address (a tool edit's proposal),
   *  stored with the `request.opened` row; the session log's `blobs` reads
   *  them back for as long as the row lives. */
  readonly blobs?: readonly DraftBlob[];
  /** A request a resumed call re-entered: open already, only what the
   *  policy decides now commits. */
  readonly reentered?: boolean;
  /** What the call's `PreToolUse` hooks said. */
  readonly hook?: 'allow' | 'ask';
}

/**
 * Ask a person: open the request on its run through `opening.commit`,
 * with the policy's own answer beside it, and wait for a decision its kind
 * takes. The policy's answer returns at once; a person's is read from the
 * row stream. An interruption anywhere in the call closes the request as
 * cancelled, so none is left pending; a session that closes first answers
 * with a cancellation.
 */
export const openRequest = <P extends PermissionPayload, E = never>(
  runId: RunId,
  payload: P,
  opening: RequestOpening<E>,
): Effect.Effect<
  DecisionOf<P['kind']>,
  LogWriteError | E,
  SessionLog | Approvals | Interactions
> =>
  Effect.gen(function* () {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    const decided = yield* policyDecidedRows(runId, payload, opening.hook);
    const rows: RequestRow[] = [
      ...(opening.reentered
        ? []
        : [
            {
              type: 'request.opened' as const,
              aggregateId,
              requestId,
              payload,
              ...(opening.blobs && { blobs: opening.blobs }),
            },
          ]),
      ...decided,
    ];
    const from = yield* opening.commit(rows);
    const answer = decided[0]?.decision;
    if (answer !== undefined) return yield* recordedDecision(payload, answer);
    return yield* decisionOf(runId, requestId, from).pipe(
      Effect.flatMap((row) => recordedDecision(payload, row.decision)),
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
  });

/** The session's requests ({@link SessionRequestsShape}): the one handler
 *  of every request a surface issues. */
export class SessionRequests extends Context.Service<
  SessionRequests,
  SessionRequestsShape
>()('@texra-ai/harness/session/SessionRequests') {}
