/**
 * A run's questions to a person, as rows: what the
 * session's approval policy settles when a request opens, decided in core so
 * that `yolo` and `never` mean one thing on every host; `ask`, which opens a
 * request with that answer beside it and waits for the `request.decided`
 * that closes it; and `decide`, the one writer of a surface's decision. The
 * answer is recorded as the `request.decided` row beside the request's own
 * `request.opened`, in the same batch, so no surface ever lists it pending.
 * A request a stopped or failed run leaves open is cancelled with the run's
 * end, in the end's batch (`endIn`); one a dead process left, with the
 * run's next activation.
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
  type CommitOrdinal,
  type DecisionOf,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runState';
import type { Append } from '@shared/session/sessionEvents';
import type { LogWriteError } from '@shared/session/sessionLog';
import type { ToolStep } from '@tools/sessionTools';

import { HostCapabilities, type StepToolInputs } from './agentToolResolution';
import { Interactions } from './HostInteractions';
import { RunCall } from './RunCall';
import type { AgentRunShape } from './run/AgentRun';
import type {
  AskOptions,
  RequestRow,
  SessionRequestsShape,
} from './SessionHandle';

/** The session's approvals and its presentation host: what the policy's
 *  answers read. */
const policyOwners = Effect.all({
  approvals: Approvals,
  interactions: Interactions,
});
type PolicyOwners = Effect.Success<typeof policyOwners>;
type DecidedDraft = Extract<RunHistoryDraft, { type: 'request.decided' }>;

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

/** The policy's answer for one request: a plan follows the executable rule
 *  (`never` denies, `yolo` approves, `ask` presents or, with nobody to ask,
 *  denies), and a question or a retry is denied under `yolo` rather than
 *  answered on a person's behalf. */
function answerFor(
  owners: PolicyOwners,
  runId: RunId,
  payload: PermissionPayload,
  hook: 'allow' | 'ask' | undefined,
):
  | {
      readonly decision: RequestDecision;
      readonly denial?: ApprovalPolicyDenial;
    }
  | undefined {
  const policy = owners.approvals.policy(runId);
  switch (payload.kind) {
    case 'planApproval': {
      const answer = owners.approvals.permission(runId, 'plan', hook);
      if (answer === 'ask') return undefined;
      return { decision: answer === 'allow' ? { action: 'approve' } : answer };
    }
    case 'userQuestion': {
      const decision = decideHumanInputRequest({
        policy,
        canPresent: canPresent(owners),
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
        canPresent: canPresent(owners),
        isCredentialFailure: payload.data.credentialSwitch != null,
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
    case 'plugin':
      return undefined;
  }
}

/**
 * The rows that record the policy's answer beside a request about to open:
 * none when a surface decides. A denial is told to the attached host as the
 * request opens.
 */
function decidedRows(
  owners: PolicyOwners,
  runId: RunId,
  payload: PermissionPayload,
  hook?: 'allow' | 'ask',
): DecidedDraft[] {
  const answer = answerFor(owners, runId, payload, hook);
  if (answer === undefined) return [];
  if (answer.denial) owners.interactions.approvalDenied(answer.denial, runId);
  return [
    {
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', runId),
      requestId: payload.data.requestId,
      decision: answer.decision,
    },
  ];
}

/** {@link decidedRows} under the session's own policy and host. */
export const policyDecidedRows = (
  runId: RunId,
  payload: PermissionPayload,
): Effect.Effect<DecidedDraft[], never, Approvals | Interactions> =>
  Effect.map(policyOwners, (owners) => decidedRows(owners, runId, payload));

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

const CHANNEL = 'requestPolicy';

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

/** Build one session's {@link SessionRequests} `ask`, `decide` and
 *  `decision`, over its log, its policy and its host. */
export const requestAsks: Effect.Effect<
  Pick<SessionRequestsShape, 'ask' | 'decide' | 'decision'>,
  never,
  SessionLog | Approvals | Interactions
> = Effect.gen(function* () {
  const log = yield* SessionLog;
  const owners = yield* policyOwners;
  const decide: SessionRequestsShape['decide'] = (runId, requestId, answer) =>
    log.transact((tx) => decisionRow(runId, requestId, answer, tx.append));

  /** The `request.decided` row for `requestId`, if the request is still
   *  open: the body of one publisher transaction, whether a surface or an
   *  interrupted {@link ask} decides it. It reads the run's request rows
   *  alone (the `requests` read, through the type index), so a decision
   *  costs the same however long the run's history grows, and asks their
   *  `RunRows` whether the request is open, as the run state does. */
  const decisionRow = Effect.fn('decisionRow')(function* (
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
    append: Append,
  ) {
    const aggregateId = qualifyAggregateId('run', runId);
    const { requests } = yield* log.runRows(aggregateId, 'requests');
    if (requests[requestId]?.decision !== null) return false;
    yield* runStateAppend(append)([
      { type: 'request.decided', aggregateId, requestId, decision },
    ]);
    return true;
  });

  const decision: SessionRequestsShape['decision'] = (runId, id, from) => {
    const aggregate = qualifyAggregateId('run', runId);
    return log.tail(from).pipe(
      Stream.filter(isRequestDecision),
      Stream.filter(
        (event) => event.aggregateId === aggregate && event.requestId === id,
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new Error(`The session closed before request ${id} was decided.`),
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
          const from = log.now();
          return log
            .transact((tx) => runStateAppend(tx.append)(opened))
            .pipe(Effect.as(from));
        }));
    return Effect.gen(function* () {
      const rows: RequestRow[] = [
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload,
          ...(options.blobs && { blobs: options.blobs }),
        },
        ...decidedRows(owners, runId, payload, (yield* RunCall)?.hook),
      ];
      const from = yield* open(rows);
      return yield* decision(runId, requestId, from).pipe(
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
  };

  return { ask, decide, decision };
});

/** The session's requests ({@link SessionRequestsShape}): the one handler
 *  of every request a surface issues, and its runs' questions to a person. */
export class SessionRequests extends Context.Service<
  SessionRequests,
  SessionRequestsShape
>()('@texra-ai/harness/session/SessionRequests') {}
