/**
 * A run's questions to a person, as rows of the run. Every asker (a tool
 * call's request, a plugin's request no call waits on, the invoker's
 * retry) opens through the run's cell at the one door
 * ({@link openRequest}): its `request.opened` and, when the session's
 * policy answers it (a `yolo` or `never` policy, a grant that covers it,
 * nobody to ask), the `request.decided` beside it in the same batch, so no
 * surface ever lists it pending; otherwise the asker waits on the row
 * stream for the decision a surface lands, the one wait
 * ({@link decisionOf}). Every decision is one checked append
 * ({@link decideRequest}): a surface's answer, a grant change answering
 * the requests it covers, and the invoker's own. A request a stopped or
 * failed run leaves open is cancelled with the run's end, in the end's
 * batch (`endIn`); one a dead process left, with the run's next activation
 * (`cancelRequestRows`).
 *
 * Who answers a request (`answeredBy`) is decided once, as it opens
 * ({@link answererOf}): its operation's grant ({@link OPERATIONS}), or a
 * person when the call's hooks asked or it asks about no operation. The
 * policy's answer as it opens and a grant turned on while it waits
 * (`approvalsUnder`) both read it, so they agree. A command, an edit and a
 * delegation proposal reach the door already decided by
 * {@link sessionPermission}, so they present.
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
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import {
  approvalPolicyDenialMessage,
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
  grantAnswering,
  decisionFits,
  qualifyAggregateId,
  type AnsweredBy,
  type CommitOrdinal,
  type DecisionOf,
  type RequestPayload,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { RunHistoryDraft } from '@shared/session/runState';
import type {
  ApprovalOperation,
  ApprovalsWithPermission,
  HookAnswer,
  SessionApprovals,
} from '@shared/session/sessionApprovals';
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

/** Each operation a run asks permission for: the grant that answers it. A
 *  call of a tool that declares no `command.grant` takes the run's
 *  delegated-work grant, so a command grant never approves it. */
const OPERATIONS = {
  bash: 'bash',
  call: 'superYolo',
  toolEdit: 'toolEdit',
  plan: 'superYolo',
  proposal: 'superYolo',
} as const satisfies Record<ApprovalOperation, ApprovalBypassKind>;

/** The operation a request of each kind asks permission for, where its
 *  kind says which; a command names its own as it opens (the guard's
 *  `askCommandApproval`). */
const KIND_OPERATIONS: Partial<
  Record<RequestPayload['kind'], ApprovalOperation>
> = { toolEdit: 'toolEdit', planApproval: 'plan', proposal: 'proposal' };

/** Who answers a request about `operation`, given what the call's hooks
 *  said: a person when a hook asked or there is no operation (a question, a
 *  retry, a plugin's request), else the operation's grant. */
const answererOf = (
  operation: ApprovalOperation | undefined,
  hook: HookAnswer,
): AnsweredBy =>
  operation === undefined || hook === 'ask' ? 'person' : OPERATIONS[operation];

/**
 * The one reading of the policy for a request `answeredBy` names, with what
 * the call's `PreToolUse` hooks said: `never`, or an ask nobody can answer,
 * denies whatever a hook said; else a hook's `ask` asks and its `allow`
 * answers what the policy would ask; a grant that answers it approves it.
 */
const permissionOf = (
  owners: {
    readonly approvals: Pick<SessionApprovals, 'policy' | 'bypass'>;
    readonly interactions: Pick<
      Interactions['Service'],
      'approvalPromptsUnavailable'
    >;
  },
  runId: RunId,
  answeredBy: AnsweredBy,
  hook: HookAnswer,
): ReturnType<ApprovalsWithPermission['permission']> => {
  const { approvals, interactions } = owners;
  const canPresent = !interactions.approvalPromptsUnavailable;
  const decision = decideApproval({
    policy: approvals.policy(runId),
    scopedBypass: grantAnswering(
      (kind) => approvals.bypass(runId, kind) !== null,
      answeredBy,
    ),
    canPresent,
  });
  const denied = isApprovalDenied(decision)
    ? decision
    : hook === 'ask' && !canPresent && 'deny-unpresentable';
  if (denied)
    return { action: 'deny', reason: approvalPolicyDenialMessage(denied) };
  return hook ?? (decision === 'allow' ? 'allow' : 'ask');
};

/** The session's one reading of the policy for an operation of a run
 *  before a request about it opens (`Approvals.permission`): what such a
 *  request would be answered with as it opens. */
export const sessionPermission =
  (
    approvals: Pick<SessionApprovals, 'policy' | 'bypass'>,
    interactions: Interactions['Service'],
  ): ApprovalsWithPermission['permission'] =>
  (runId, operation, hook) =>
    permissionOf(
      { approvals, interactions },
      runId,
      answererOf(operation, hook),
      hook,
    );

/** The policy's answer for one request, or undefined when a person
 *  answers: a plan, a command, an edit or a proposal follows the one
 *  reading ({@link permissionOf}), so a grant that answers it approves it;
 *  a question or a retry is denied under `yolo` rather than answered on a
 *  person's behalf. */
function answerFor(
  owners: PolicyOwners,
  runId: RunId,
  payload: RequestPayload,
  answeredBy: AnsweredBy,
  hook: HookAnswer,
): RequestDecision | undefined {
  const policy = owners.approvals.policy(runId);
  switch (payload.kind) {
    case 'planApproval':
    case 'proposal':
    case 'toolEdit':
    case 'bash': {
      const answer = permissionOf(owners, runId, answeredBy, hook);
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
    case 'plugin':
      return undefined;
  }
}

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
 * Answer a request a person decides, if it is still open. (A cancelled run,
 * a bypassed approval and a personal-key retry write their own
 * `request.decided` rows.) The check reads the committed rows and the
 * `request.decided` lands in one
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

/**
 * The decision on request `requestId` of `runId`: the first
 * `request.decided` the session log commits for it above `from`. The one
 * wait of every asker a person answers: a tool call's request, the
 * invoker's retry, a script's shared agent request. A session that closes
 * first decides nothing: the waiting fiber is interrupted, so the call or
 * turn that asked stays in flight and the next resume asks again. A log
 * that cannot be read fails the wait.
 */
export const decisionOf = (
  runId: RunId,
  requestId: string,
  from: CommitOrdinal,
): Effect.Effect<RequestDecision, DatabaseReadFailed, SessionLog> =>
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
            Effect.logWarning(
              `Request ${requestId}: the session closed before it was decided; its asker stops, and the next resume asks again`,
            ).pipe(withLogChannel(CHANNEL), Effect.andThen(Effect.interrupt)),
          onSome: (row) => Effect.succeed(row.decision),
        }),
      ),
    );
  });

/** The cell a request opens through: its run, and the append of the
 *  asker's batch (the run's cell, or a call's commit through it). */
interface AskerCell<E> {
  readonly runId: RunId;
  readonly append: (
    rows: readonly RunHistoryDraft[],
  ) => Effect.Effect<{ readonly commit: CommitOrdinal }, E>;
}

/** How {@link openRequest} opens a request: what it asks about, and what
 *  the asker's batch carries beside it. */
interface RequestOpening {
  /** The strings the payload names by address (a tool edit's proposal),
   *  stored with the `request.opened` row; the session log's `blobs` reads
   *  them back for as long as the row lives. */
  readonly blobs?: readonly DraftBlob[];
  /** A request a resumed call re-entered, as it opened, and the commit
   *  the resume read it open at: open already, only what the policy
   *  decides now commits, and a person's answer since is read from there. */
  readonly reentered?: {
    readonly answeredBy: AnsweredBy;
    readonly openAt: CommitOrdinal;
  };
  /** What the call's `PreToolUse` hooks said. */
  readonly hook?: 'allow' | 'ask';
  /** What the request asks permission for, where its kind does not say:
   *  a command's operation. */
  readonly operation?: ApprovalOperation;
  /** The asker's own rows, committed after the `request.opened` in its
   *  batch: the invoker's `failed` row, which the cell requires to follow
   *  the request it asks. */
  readonly beside?: readonly RunHistoryDraft[];
}

/** A request {@link openRequest} opened: the policy's answer, or null when
 *  a person answers it, whose decision is read from `from`
 *  ({@link decisionOf}). */
interface OpenedRequest<K extends RequestPayload['kind']> {
  readonly answer: DecisionOf<K> | null;
  readonly from: CommitOrdinal;
}

/**
 * Open `payload` on its run through the asker's cell: its
 * `request.opened`, naming who answers it ({@link answererOf}), the
 * asker's rows `beside` it, and the policy's own answer when the policy
 * answers it, in one batch, so no surface lists as pending a request the
 * policy answered. The one door every asker opens through; a person's
 * answer is the one wait ({@link decisionOf}). A request the run's end
 * leaves open is cancelled by the end's transaction (`endIn`).
 */
export const openRequest = <P extends RequestPayload, E>(
  cell: AskerCell<E>,
  payload: P,
  opening: RequestOpening = {},
): Effect.Effect<OpenedRequest<P['kind']>, E, Approvals | Interactions> =>
  Effect.gen(function* () {
    const { runId } = cell;
    const { requestId } = payload.data;
    const aggregateId = qualifyAggregateId('run', runId);
    const { reentered, hook } = opening;
    const answeredBy =
      reentered?.answeredBy ??
      answererOf(opening.operation ?? KIND_OPERATIONS[payload.kind], hook);
    const decision = answerFor(
      yield* policyOwners,
      runId,
      payload,
      answeredBy,
      hook,
    );
    const answer =
      decision === undefined
        ? null
        : yield* recordedDecision(payload, decision);
    const decided: readonly RunHistoryDraft[] =
      decision === undefined
        ? []
        : [{ type: 'request.decided', aggregateId, requestId, decision }];
    if (reentered !== undefined) {
      if (decided.length > 0) yield* cell.append(decided);
      return { answer, from: reentered.openAt };
    }
    const { commit } = yield* cell.append([
      {
        type: 'request.opened',
        aggregateId,
        requestId,
        payload,
        answeredBy,
        ...(opening.blobs && { blobs: opening.blobs }),
      },
      ...(opening.beside ?? []),
      ...decided,
    ]);
    return { answer, from: commit };
  });

/** The session's requests ({@link SessionRequestsShape}): the one handler
 *  of every request a surface issues. */
export class SessionRequests extends Context.Service<
  SessionRequests,
  SessionRequestsShape
>()('@texra-ai/harness/session/SessionRequests') {}
