/**
 * A run's questions to a person, as rows of the run. Every asker (a tool
 * call's request, the invoker's retry) opens through the run's cell at the one door
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
 * (`cancelRequestRows`). Either way the asker asks again when its run
 * resumes. A person's answer to a request of a run no process holds
 * resumes that run, and the activation commits it instead of the
 * cancellation, so the asker takes it (`RunRegistry.holdAnswer`).
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
} from '@shared/approvalBypassKind';
import {
  decideApproval,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  grantAnswering,
  decisionFits,
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

/** The policy's answer for `ask` on `runId`, under what the session's host
 *  can answer, read live: a host attached after a run started still
 *  answers for it. */
const policyAnswer = (
  owners: {
    readonly approvals: Pick<SessionApprovals, 'policy'>;
    readonly interactions: Pick<
      Interactions['Service'],
      'approvalPromptsUnavailable'
    >;
  },
  runId: RunId,
  ask: ApprovalAsk,
  policy = owners.approvals.policy(runId),
): ApprovalDecision =>
  decideApproval({
    policy,
    canPresent: !owners.interactions.approvalPromptsUnavailable,
    ask,
  });

/** The policy's answer for a run's approval-gated tools: whether a step
 *  withholds them, and whether the run's work runs unasked
 *  ({@link workAutoApproved}). A run whose delegated work is bypassed (an
 *  Auto-approve launch) is asked nothing: every approval it would open is
 *  granted. */
const decideExecutable = (
  owners: PolicyOwners,
  runId: RunId,
  policy = owners.approvals.policy(runId),
  granted = owners.approvals.bypass(runId, 'superYolo') !== null,
): ApprovalDecision =>
  policyAnswer(
    owners,
    runId,
    { kind: 'operation', granted, hook: undefined },
    policy,
  );

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

/** Each operation a run asks permission for: the grant that answers it, or
 *  a person. A call of a tool that declares no `command.grant` takes the
 *  run's delegated-work grant, so a command grant never approves it.
 *  Trusting a plugin's native code is a person's own answer, whatever the
 *  policy, a grant or a hook says. */
const OPERATIONS = {
  bash: 'bash',
  call: 'superYolo',
  toolEdit: 'toolEdit',
  plan: 'superYolo',
  proposal: 'superYolo',
  trust: 'person',
} as const satisfies Record<ApprovalOperation, AnsweredBy>;

/** The operation `payload` asks permission for, where its kind says which;
 *  a command names its own as it opens (the guard's `askCommandApproval`).
 *  Trusting a plugin is a call's, unless the plugin carries native code. */
export const operationOf = (
  payload: RequestPayload,
): ApprovalOperation | undefined => {
  switch (payload.kind) {
    case 'toolEdit':
      return 'toolEdit';
    case 'planApproval':
      return 'plan';
    case 'proposal':
      return 'proposal';
    case 'pluginTrust':
      return payload.data.native === undefined ? 'call' : 'trust';
    case 'bash':
    case 'userQuestion':
    case 'retry':
      return undefined;
  }
};

/** Who answers a request about `operation`, given what the call's hooks
 *  said: a person when a hook asked or there is no operation (a question or
 *  a retry), else the operation's grant or a person. */
const answererOf = (
  operation: ApprovalOperation | undefined,
  hook: HookAnswer,
): AnsweredBy =>
  operation === undefined || hook === 'ask' ? 'person' : OPERATIONS[operation];

/** What a request about an operation asks the policy: whether a grant
 *  answers the request `answeredBy` names, and what the call's
 *  `PreToolUse` hooks said. A request a person answers asks as one a hook
 *  asked about: no policy, grant or hook's `allow` answers it, and where no
 *  person can be asked it is denied. */
const operationAsk = (
  approvals: Pick<SessionApprovals, 'bypass'>,
  runId: RunId,
  answeredBy: AnsweredBy,
  hook: HookAnswer,
): ApprovalAsk => ({
  kind: 'operation',
  granted: grantAnswering(
    (kind) => approvals.bypass(runId, kind) !== null,
    answeredBy,
  ),
  hook: answeredBy === 'person' ? 'ask' : hook,
});

/** The session's one reading of the policy for an operation of a run
 *  before a request about it opens (`Approvals.permission`): what such a
 *  request would be answered with as it opens. */
export const sessionPermission =
  (
    approvals: Pick<SessionApprovals, 'policy' | 'bypass'>,
    interactions: Interactions['Service'],
  ): ApprovalsWithPermission['permission'] =>
  (runId, operation, hook) => {
    const answer = policyAnswer(
      { approvals, interactions },
      runId,
      operationAsk(approvals, runId, answererOf(operation, hook), hook),
    );
    return answer === 'present' ? 'ask' : answer;
  };

/** The policy's answer for one request, or undefined when a person
 *  answers: a plan, a command, an edit or a proposal is an operation a
 *  grant may answer; a question or a retry is denied under `yolo` rather
 *  than answered on a person's behalf. */
function answerFor(
  owners: PolicyOwners,
  runId: RunId,
  payload: RequestPayload,
  answeredBy: AnsweredBy,
  hook: HookAnswer,
): RequestDecision | undefined {
  const ask = ((): ApprovalAsk => {
    switch (payload.kind) {
      case 'planApproval':
      case 'proposal':
      case 'toolEdit':
      case 'bash':
      case 'pluginTrust':
        return operationAsk(owners.approvals, runId, answeredBy, hook);
      case 'userQuestion':
        return { kind: 'question' };
      case 'retry':
        return {
          kind: 'retry',
          credentialFailure: payload.data.credentialSwitch !== null,
        };
    }
  })();
  const answer = policyAnswer(owners, runId, ask);
  if (answer === 'present') return undefined;
  return answer === 'allow' ? { action: 'approve' } : answer;
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
  const view = yield* SubscriptionRef.get((yield* SessionViewAccess).ref);
  const start = entry.registration?.start ?? null;
  const parent = start?.parent?.id ?? null;
  const source =
    start === null ? view : withUnborn(view, runId, parent, start.grants);
  const policy = runPolicy(owners.approvals.policy(), source, runId);
  const bypassed = resolveBypass(source, runId, 'superYolo') !== null;
  return {
    approvalPromptsUnavailable:
      typeof decideExecutable(owners, runId, policy, bypassed) === 'object',
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
        const aggregateId = runId;
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
    const aggregate = runId;
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
  /** What the call's `PreToolUse` hooks said. */
  readonly hook?: HookAnswer;
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
    const aggregateId = runId;
    const { hook } = opening;
    const answeredBy = answererOf(
      opening.operation ?? operationOf(payload),
      hook,
    );
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
