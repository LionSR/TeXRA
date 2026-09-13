/**
 * The one pure run-state fold. `RunLedger.load` runs it over a run's rows,
 * `appendBatch` runs it over the rows it just committed, and the trace
 * viewer's stepper (PR 3) runs it over the same rows up to a chosen commit.
 * Because the same function produces the state the loop saw when it appended
 * step k, "state at step k" and "resume would continue after step k" are the
 * same fact: replay along the flow, without re-executing anything.
 *
 * Pure in the sense that matters: no IO, no clock, no platform, no store
 * read, no synthetic id, no dependence on `Map` iteration order in any output
 * value. Every value it produces comes from a row. It applies no redaction:
 * display redaction is a later boundary, and a redacted fold produces a
 * conversation the provider rejects.
 *
 * A sibling of `sessionFold.ts`, never a section inside it: that fold
 * produces what people see, this one produces what the loop continues from.
 */
import { Data, Result } from 'effect';

import {
  assistantMessageFromResult,
  type Continuation,
  type MessageSchema,
  type ModelOrigin,
  type RemoteOperation,
  type TurnResult,
} from '@llm/turn';
import {
  EMPTY_RUN_USAGE_TOTALS,
  FlowSnapshotPayloadSchema,
  RunUsageTotalsSchema,
  requestParksItsCaller,
  type CommitOrdinal,
  type FlowSnapshotPayload,
  type DispatchFacts,
  type FlowStep,
  type InvocationRef,
  type ModelCompatibilityKey,
  type NormalizedUsage,
  type PermissionPayload,
  type RequestDecision,
  type RetryErrorInfo,
  type RunFamily,
  type RunLoopPhase,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
  type SnapshotRuntime,
  type StateOperation,
  type ToolResultPayload,
} from '@shared/schemas';
import { isObject } from '@utils/core';
import type { z } from 'zod';

/**
 * The rows `RunLedger.appendBatch` commits: the six ledger arms plus the
 * display arms a batch has to commit atomically with them. A tool call's card
 * settles with its `tool.result` — `tool.end` for a card the dispatcher
 * already opened, both card rows for a fast tool whose card opens and closes
 * in that one batch; an approval's recovery binding is the `flow.snapshot`
 * committed in the same batch; a streaming row still open when the loop
 * parks closes with the `waiting` step, in that step's batch. Publishing
 * those companions separately is the
 * crash window where a settled tool keeps an active card, or a terminal card
 * claims a result no row holds, or an approval survives with nothing to
 * recover it by. An explicit list narrowed from `SessionEventDraft`, never
 * `SessionEventDraft` itself: a card the ledger opens is one a settlement in
 * the same batch closes, and no other row type reaches `appendBatch`.
 */
export type RunLedgerDraft = Extract<
  SessionEventDraft,
  {
    type:
      | 'flow.step'
      | 'model.message'
      | 'model.compaction'
      | 'tool.intent'
      | 'tool.result'
      | 'flow.snapshot'
      | 'tool.start'
      | 'tool.end'
      | 'stream.end'
      | 'request.opened'
      | 'request.decided';
  }
>;

export class RunLedgerInconsistent extends Data.TaggedError(
  'RunLedgerInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing, or a row before the row it presupposes
    | 'stale-snapshot' // a snapshot contradicts rows already folded
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'dangling-binding' // a request binding names no row
    | 'mismatched-delivery' // a delivering append does not settle its response
    | 'invalid-mutation'; // a tool.result state operation names no slice or leaves an invalid state
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}

/** The family state a `flow.snapshot` restores, keyed by its family. */
const FlowStateSchema = FlowSnapshotPayloadSchema.options.map((arm) =>
  arm.pick({ family: true, state: true }),
);
type FlowState = z.output<(typeof FlowStateSchema)[number]>;
type RunUsageTotals = z.output<typeof RunUsageTotalsSchema>;
type Message = z.output<typeof MessageSchema>;

/** The family state of a snapshot, keeping the family/state correlation. */
const flowOf = (p: FlowSnapshotPayload): FlowState =>
  p.family === 'toolUse'
    ? { family: p.family, state: p.state }
    : { family: p.family, state: p.state };

type OpenAttempt = {
  readonly invocation: InvocationRef;
  readonly origin: ModelOrigin;
  readonly delivery: 'stream' | 'blocking' | 'background';
  readonly providerResponseId: string | null;
  readonly returnedModel: string | null;
  readonly accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  } | null;
};

type Settlement = Pick<
  ToolResultPayload,
  'attempt' | 'disposition' | 'duplicateOf' | 'result' | 'attachments'
>;

type PendingResponse = {
  readonly responseId: string;
  readonly invocation: InvocationRef;
  readonly turn: TurnResult;
  readonly calls: readonly DispatchFacts[];
  /** Committed settlements by call id, exactly one per settled call. */
  readonly settled: Readonly<Record<string, Settlement>>;
};

type PendingIntent = {
  readonly attempt: number;
  readonly responseId: string;
  /** The approval that guards this call, when one was raised: the
   *  `flow.snapshot` in the approval's batch is its only carrier. */
  readonly approvalRequestId: string | null;
};

type RequestState = {
  readonly payload: PermissionPayload;
  readonly resolved: boolean;
  /** The recorded decision (R5): the `request.decided` row's, null while
   *  the request is open. */
  readonly decision: RequestDecision | null;
};

/**
 * What the loop continues from. A plain type with no schema of its own,
 * because giving it one invites persisting it (C10). Every field is derived
 * from the row that produced it.
 */
export type RunState = {
  /** The last folded row. */
  readonly commit: CommitOrdinal;
  readonly snapshotCommit: CommitOrdinal | null;
  /** Ledger rows folded into this state: zero means a snapshot restores its
   *  references, anything else means the snapshot is checked against them. */
  readonly rowsBeforeSnapshot: number;
  readonly family: RunFamily | null;
  readonly step: FlowStep | null;
  readonly outcome: RunOutcome | null;
  /** `null` until the opening `flow.snapshot`: no row that presupposes an
   *  opened run folds before it. */
  readonly phase: RunLoopPhase | null;
  readonly round: number;
  readonly turn: number;
  readonly continuationIndex: number;
  readonly modelId: string | null;
  readonly modelCompatibilityKey: ModelCompatibilityKey | null;
  readonly lastError: RetryErrorInfo | null;
  readonly pendingRetry: SnapshotRuntime['pendingRetry'];
  /** Subscription routes this run declines: the retries the user answered
   *  with their own API key, plus the launch's seed. */
  readonly declinedRoutes: SnapshotRuntime['declinedRoutes'];
  /** Canonical provider history, in order. The pending response's assistant
   *  message enters only with its delivering `append`. */
  readonly messages: readonly Message[];
  readonly continuation: Continuation | null;
  readonly openAttempt: OpenAttempt | null;
  /** The last completed turn, from its `response` row: the finish reason a
   *  loop reads when it processes a response it did not just receive. */
  readonly lastTurn: TurnResult | null;
  readonly pendingResponse: PendingResponse | null;
  /** By call id. */
  readonly pendingIntents: Readonly<Record<string, PendingIntent>>;
  /** By request id, with its recovery binding resolved at each snapshot. */
  readonly requests: Readonly<Record<string, RequestState>>;
  /** Derived (D12): the priced usage stamped on every `response` row plus
   *  `tool.result` `add` operations. No snapshot carries it. */
  readonly usage: RunUsageTotals;
  readonly flow: FlowState | null;
};

type LedgerRowType = RunLedgerDraft['type'];

/**
 * Display rows ignored by name. Anything on the run aggregate that is neither
 * here nor a ledger arm is `unknown-run-row`, never a quiet `default`. The
 * record is total over the event vocabulary, so a new display arm is a
 * compile error here until it is classified.
 */
const IGNORED_ROW_TYPES: Readonly<
  Record<Exclude<SessionEvent['type'], LedgerRowType>, true>
> = {
  'run.start': true,
  'run.activate': true,
  'run.config': true,
  'run.detach': true,
  'run.end': true,
  'run.removed': true,
  'run.description': true,
  'conversation.progress': true,
  updateTodos: true,
  updatePlan: true,
  addOutputFiles: true,
  updateMissingOutputs: true,
  updateCompileFailures: true,
  goalStateChanged: true,
  inquiryThreadUpdated: true,
  updateQueuedFollowUps: true,
  'approval.policy': true,
  log: true,
  'stage.start': true,
  'stage.end': true,
  'workflow.plan': true,
  'workflow.call': true,
  'skills.snapshot': true,
  usage: true,
  'context.state': true,
  'stream.start': true,
  'response.finalized': true,
  domain: true,
  'run.record': true,
  'run.launchLabel': true,
  'run.report': true,
  'run.result': true,
  'run.workspaceFiles': true,
  'run.workflow': true,
  // The child loop's own bookkeeping: folded by its readers, not the loop.
  'child.turn': true,
  // Checkpoint-aggregate rows never reach a run fold; total-record members.
  'workflow.script': true,
  'workflow.journal': true,
  'workflow.attempt': true,
  'desktop.projects.changed': true,
  'inquiry.recorded': true,
  'update.check.recorded': true,
  'state.value.set': true,
};
const IGNORED = new Set<string>(Object.keys(IGNORED_ROW_TYPES));

/**
 * A record keyed by an id the state carries: call ids come from the provider,
 * so the key `__proto__` is reachable from outside. On a plain object it would
 * hit the inherited setter instead of creating an own entry, and an intent
 * that is absent from `Object.keys` is an outcome-unknown barrier the resume
 * rule never sees. Null-prototype, therefore, for every id-keyed record here:
 * one rule, no per-key reasoning about which ids a provider can choose.
 */
function byId<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

/** The state a run starts from: every field at its zero, no family bound
 *  yet. Both run programs open from this and stamp their own family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  commit,
  snapshotCommit: null,
  rowsBeforeSnapshot: 0,
  family: null,
  step: null,
  outcome: null,
  phase: null,
  round: 0,
  turn: 0,
  continuationIndex: 0,
  modelId: null,
  modelCompatibilityKey: null,
  lastError: null,
  pendingRetry: null,
  declinedRoutes: [],
  messages: [],
  continuation: null,
  openAttempt: null,
  lastTurn: null,
  pendingResponse: null,
  pendingIntents: byId([]),
  requests: byId([]),
  usage: EMPTY_RUN_USAGE_TOTALS,
  flow: null,
});

/** The recovery bindings a snapshot carries (R5): the retry permit's request
 *  and the approval request of every pending intent. */
function requestBindings(state: RunState): ReadonlySet<string> {
  const bindings = new Set<string>();
  if (state.pendingRetry !== null) bindings.add(state.pendingRetry.requestId);
  for (const intent of Object.values(state.pendingIntents)) {
    if (intent.approvalRequestId !== null) {
      bindings.add(intent.approvalRequestId);
    }
  }
  return bindings;
}

/**
 * The undecided requests nothing can recover: no binding names them, and
 * they are not the one kind that outlives the process that asked. A request
 * the session opened for a tool (a command, an edit, a plan, a delegation,
 * a question) parks that tool, so a new owner can neither answer it nor
 * re-ask it — the snapshot arm below refuses to be authored over one, and a
 * resume retires them as cancelled before it authors a snapshot
 * (`RunLedger.acquire`). An `externalInquiry` is the exception by contract:
 * its tool returns at once and its answer arrives as a follow-up, whichever
 * process is running the run by then, so it stands unbound across every
 * snapshot its run writes.
 */
export function unboundRequests(state: RunState): readonly string[] {
  const bindings = requestBindings(state);
  return Object.entries(state.requests).flatMap(([requestId, request]) =>
    request.resolved ||
    bindings.has(requestId) ||
    !requestParksItsCaller(request.payload)
      ? []
      : [requestId],
  );
}

type Fold = Result.Result<RunState, RunLedgerInconsistent>;

const refuse = (
  reason: RunLedgerInconsistent['reason'],
  detail: string,
  commit: CommitOrdinal | null,
): Result.Result<never, RunLedgerInconsistent> =>
  Result.fail(new RunLedgerInconsistent({ reason, detail, commit }));

const sameInvocation = (a: InvocationRef, b: InvocationRef): boolean =>
  a.invocationId === b.invocationId && a.attempt === b.attempt;

/**
 * The priced usage the writer stamped on one completed turn, summed into the
 * run totals. The package's `turn.usage` is deliberately not the input: it
 * carries token counts and provider-specific extras but no runtime price, so
 * folding it would make a resumed run's `totalCost` the sum of `tool.result`
 * add operations alone. Every field of the totals is named here, so a new
 * metric on either schema is a compile error rather than a silent zero;
 * `RunUsageAccumulator` sums the same pairs on the live path.
 */
function addTurnUsage(
  totals: RunUsageTotals,
  usage: NormalizedUsage | null,
): RunUsageTotals {
  if (usage === null) return totals;
  return {
    firstInputTokens:
      totals.firstInputTokens === 0
        ? usage.inputTokens
        : totals.firstInputTokens,
    totalInputTokens: totals.totalInputTokens + usage.inputTokens,
    totalOutputTokens: totals.totalOutputTokens + usage.outputTokens,
    totalCost: totals.totalCost + usage.cost,
    totalCacheReadInputTokens:
      totals.totalCacheReadInputTokens + (usage.cachedInputTokens ?? 0),
    totalCacheMissInputTokens:
      totals.totalCacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
    totalCacheCreationInputTokens:
      totals.totalCacheCreationInputTokens + (usage.cacheCreationTokens ?? 0),
    totalReasoningTokens:
      totals.totalReasoningTokens + (usage.reasoningTokens ?? 0),
    totalToolUsePromptTokens:
      totals.totalToolUsePromptTokens + (usage.toolUsePromptTokens ?? 0),
    totalServerToolRequests:
      totals.totalServerToolRequests + (usage.serverToolRequests ?? 0),
  };
}

/** One state operation over a JSON document, immutably. */
function mutate(
  node: unknown,
  path: readonly string[],
  op: StateOperation,
): Result.Result<unknown, string> {
  if (!isObject(node)) {
    return Result.fail(`path ${op.path.join('.')} crosses a non-object`);
  }
  const [key, ...rest] = path;
  if (key === undefined) return Result.fail('empty path');
  if (rest.length > 0) {
    if (!Object.hasOwn(node, key)) {
      return Result.fail(`path ${op.path.join('.')} names no ${key}`);
    }
    return Result.map(mutate(node[key], rest, op), (child) => ({
      ...node,
      [key]: child,
    }));
  }
  switch (op.op) {
    case 'set':
      return Result.succeed({ ...node, [key]: op.value });
    case 'delete': {
      if (!Object.hasOwn(node, key)) {
        return Result.fail(`delete names no ${op.path.join('.')}`);
      }
      const { [key]: _removed, ...others } = node;
      return Result.succeed(others);
    }
    case 'append': {
      const current = node[key];
      if (!Array.isArray(current)) {
        return Result.fail(`append targets a non-array ${op.path.join('.')}`);
      }
      return Result.succeed({ ...node, [key]: [...current, ...op.items] });
    }
    case 'add': {
      const current = node[key];
      if (typeof current !== 'number') {
        return Result.fail(`add targets a non-number ${op.path.join('.')}`);
      }
      return Result.succeed({ ...node, [key]: current + op.amount });
    }
  }
}

/**
 * Apply a settlement's operations over the run's mutable slices, `usage` and
 * the family `state`, and re-validate both through their schemas so the
 * state stays typed without a cast.
 */
function applyMutations(
  state: RunState,
  ops: readonly StateOperation[],
  commit: CommitOrdinal,
): Fold {
  if (ops.length === 0) return Result.succeed(state);
  let document: unknown = {
    usage: state.usage,
    state: state.flow === null ? null : state.flow.state,
  };
  for (const op of ops) {
    const next = mutate(document, op.path, op);
    if (Result.isFailure(next)) {
      return refuse('invalid-mutation', next.failure, commit);
    }
    document = next.success;
  }
  if (!isObject(document)) {
    return refuse('invalid-mutation', 'the slices are not an object', commit);
  }
  const usage = RunUsageTotalsSchema.safeParse(document.usage);
  if (!usage.success) {
    return refuse('invalid-mutation', usage.error.message, commit);
  }
  if (state.flow === null) {
    if (document.state !== null) {
      return refuse('invalid-mutation', 'no family state to mutate', commit);
    }
    return Result.succeed({ ...state, usage: usage.data });
  }
  const arm = FlowStateSchema.find(
    (candidate) => candidate.shape.family.value === state.flow?.family,
  );
  const flow = arm?.safeParse({
    family: state.flow.family,
    state: document.state,
  });
  if (flow === undefined || !flow.success) {
    return refuse(
      'invalid-mutation',
      flow === undefined ? 'unknown family' : flow.error.message,
      commit,
    );
  }
  return Result.succeed({ ...state, usage: usage.data, flow: flow.data });
}

const opened = (state: RunState | null): state is RunState =>
  state !== null && state.phase !== null;

function foldRow(current: RunState | null, row: SessionEvent): Fold | null {
  const commit = row.commit;
  if (current !== null && commit <= current.commit) {
    return refuse(
      'out-of-order',
      `commit ${commit} is not above ${current.commit}`,
      commit,
    );
  }
  switch (row.type) {
    case 'flow.step': {
      const p = row.payload;
      const state = current ?? freshRunState(commit);
      if (state.family !== null && state.family !== p.family) {
        return refuse('out-of-order', 'a step of another family', commit);
      }
      const coordinates = [
        ['round', p.round] as const,
        ['turn', p.turn] as const,
        ['continuationIndex', p.continuationIndex] as const,
      ];
      for (const [name, value] of coordinates) {
        if (value != null && value < state[name]) {
          return refuse(
            'out-of-order',
            `${name} ${value} is below ${state[name]}`,
            commit,
          );
        }
      }
      return Result.succeed({
        ...state,
        commit,
        rowsBeforeSnapshot: state.rowsBeforeSnapshot + 1,
        family: p.family,
        step: p.step,
        round: p.round ?? state.round,
        turn: p.turn ?? state.turn,
        continuationIndex: p.continuationIndex ?? state.continuationIndex,
        outcome: p.step === 'halted' ? (p.outcome ?? null) : state.outcome,
      });
    }
    case 'flow.snapshot': {
      const p = row.payload;
      const state = current ?? freshRunState(commit);
      if (state.family !== null && state.family !== p.family) {
        return refuse('stale-snapshot', 'a snapshot of another family', commit);
      }
      const { pendingIntents: intents, pendingResponse: response } =
        p.references;
      // The snapshot's own intents, restored or checked against the folded
      // ones below; either way it is the snapshot that carries the approval
      // binding, so these entries are what the next state holds.
      const pendingIntents = byId(
        intents.map((intent) => [
          intent.callId,
          {
            attempt: intent.attempt,
            responseId: intent.responseId,
            approvalRequestId: intent.approvalRequestId,
          },
        ]),
      );
      let pendingResponse: PendingResponse | null;
      if (state.rowsBeforeSnapshot === 0) {
        // Nothing folded before it: the snapshot restores its references.
        // A pending response cannot be restored from a reference alone (its
        // turn and dispatch facts live in the response row below it), so an
        // anchored read must start at or below that row.
        if (response !== null) {
          return refuse(
            'dangling-binding',
            `pending response ${response.responseId} names no folded response row`,
            commit,
          );
        }
        pendingResponse = null;
      } else {
        // Rows were folded before it: the snapshot is checked against them
        // and contributes only the approval bindings, its one carrier.
        const folded = state.pendingIntents;
        const foldedIds = Object.keys(folded);
        const stale =
          intents.length !== foldedIds.length ||
          intents.some((intent) => {
            const known = folded[intent.callId];
            return (
              known === undefined ||
              known.attempt !== intent.attempt ||
              known.responseId !== intent.responseId
            );
          });
        if (stale) {
          return refuse(
            'stale-snapshot',
            'pending intents disagree with the folded rows',
            commit,
          );
        }
        const pending = state.pendingResponse;
        const responseStale = (() => {
          if (pending === null || response === null) {
            return pending !== response;
          }
          const settledIds = Object.keys(pending.settled).sort();
          const claimed = [...response.settled].sort();
          return (
            pending.responseId !== response.responseId ||
            settledIds.length !== claimed.length ||
            settledIds.some((id, index) => id !== claimed[index])
          );
        })();
        if (responseStale) {
          return refuse(
            'stale-snapshot',
            'pending response disagrees with the folded rows',
            commit,
          );
        }
        pendingResponse = pending;
      }
      const next: RunState = {
        ...state,
        commit,
        snapshotCommit: commit,
        rowsBeforeSnapshot: state.rowsBeforeSnapshot + 1,
        family: p.family,
        ...p.runtime,
        pendingIntents,
        pendingResponse,
        flow: flowOf(p),
      };
      // Every binding names an opened request, and every undecided request
      // a new owner would have to recover is bound: one with nothing to
      // recover it by can only be retired as interrupted, which is forbidden
      // for these purposes. The inquiry {@link unboundRequests} exempts is
      // not that case: it is answered from the thread, not from the run.
      for (const requestId of requestBindings(next)) {
        if (!Object.hasOwn(next.requests, requestId)) {
          return refuse(
            'dangling-binding',
            `binding ${requestId} names no request`,
            commit,
          );
        }
      }
      const [unbound] = unboundRequests(next);
      if (unbound !== undefined) {
        return refuse(
          'dangling-binding',
          `request ${unbound} has no recovery binding`,
          commit,
        );
      }
      return Result.succeed(next);
    }
    case 'model.message': {
      const p = row.payload;
      if (p.kind === 'append' && p.sourceResponse === null) {
        const state = current ?? freshRunState(commit);
        return Result.succeed({
          ...state,
          commit,
          rowsBeforeSnapshot: state.rowsBeforeSnapshot + 1,
          messages: [...state.messages, ...p.messages],
        });
      }
      if (!opened(current)) {
        return refuse(
          'out-of-order',
          `${row.type} ${p.kind} before the opening flow.snapshot`,
          commit,
        );
      }
      const state: RunState = {
        ...current,
        commit,
        rowsBeforeSnapshot: current.rowsBeforeSnapshot + 1,
      };
      switch (p.kind) {
        case 'attempt': {
          const open = state.openAttempt;
          if (
            open !== null &&
            open.invocation.invocationId === p.invocation.invocationId &&
            p.invocation.attempt <= open.invocation.attempt
          ) {
            return refuse(
              'out-of-order',
              `attempt ${p.invocation.attempt} does not follow ${open.invocation.attempt}`,
              commit,
            );
          }
          return Result.succeed({
            ...state,
            phase: 'model.submitted',
            openAttempt: {
              invocation: p.invocation,
              origin: p.origin,
              delivery: p.delivery,
              providerResponseId: null,
              returnedModel: null,
              accepted: null,
            },
          });
        }
        case 'identified':
        case 'accepted':
        case 'response': {
          const open = state.openAttempt;
          if (open === null || !sameInvocation(open.invocation, p.invocation)) {
            return refuse(
              'dangling-binding',
              `${p.kind} names no open attempt`,
              commit,
            );
          }
          if (p.kind === 'identified') {
            return Result.succeed({
              ...state,
              openAttempt: {
                ...open,
                providerResponseId: p.providerResponseId,
                returnedModel: p.returnedModel,
              },
            });
          }
          if (p.kind === 'accepted') {
            return Result.succeed({
              ...state,
              openAttempt: {
                ...open,
                accepted: {
                  operation: p.operation,
                  deadlineAtMs: p.deadlineAtMs,
                },
              },
            });
          }
          if (state.pendingResponse !== null) {
            return refuse(
              'out-of-order',
              `response ${p.responseId} while ${state.pendingResponse.responseId} is undelivered`,
              commit,
            );
          }
          const settled: RunState = {
            ...state,
            continuation:
              p.turn.kind === 'http' ? (p.turn.continuation ?? null) : null,
            openAttempt: null,
            lastTurn: p.turn,
            pendingRetry: null,
            usage: addTurnUsage(state.usage, p.usage),
          };
          if (p.calls.length === 0) {
            return Result.succeed({
              ...settled,
              messages: [
                ...settled.messages,
                assistantMessageFromResult(p.turn),
              ],
            });
          }
          return Result.succeed({
            ...settled,
            pendingResponse: {
              responseId: p.responseId,
              invocation: p.invocation,
              turn: p.turn,
              calls: p.calls,
              settled: {},
            },
          });
        }
        case 'append': {
          const pending = state.pendingResponse;
          if (pending === null || pending.responseId !== p.sourceResponse) {
            return refuse(
              'mismatched-delivery',
              `append delivers ${p.sourceResponse}, pending is ${pending?.responseId ?? 'none'}`,
              commit,
            );
          }
          const unsettled = pending.calls.filter(
            (call) => !Object.hasOwn(pending.settled, call.callId),
          );
          if (unsettled.length > 0) {
            return refuse(
              'mismatched-delivery',
              `calls ${unsettled.map((call) => call.callId).join(', ')} are unsettled`,
              commit,
            );
          }
          return Result.succeed({
            ...state,
            messages: [
              ...state.messages,
              assistantMessageFromResult(pending.turn),
              ...p.messages,
            ],
            pendingResponse: null,
            pendingIntents: byId(
              Object.entries(state.pendingIntents).filter(
                ([, intent]) => intent.responseId !== pending.responseId,
              ),
            ),
          });
        }
      }
      // Exhaustive over `ModelMessagePayloadSchema`'s kinds: a sixth arm is a
      // compile error here, never a silently ignored row.
      return p satisfies never;
    }
    case 'model.compaction': {
      if (!opened(current)) {
        return refuse(
          'out-of-order',
          `${row.type} before the opening flow.snapshot`,
          commit,
        );
      }
      const p = row.payload;
      return Result.succeed({
        ...current,
        commit,
        rowsBeforeSnapshot: current.rowsBeforeSnapshot + 1,
        messages: [...current.messages.slice(0, p.keepPrefix), ...p.messages],
        continuation: p.continuation,
      });
    }
    case 'tool.intent': {
      if (!opened(current)) {
        return refuse(
          'out-of-order',
          `${row.type} before the opening flow.snapshot`,
          commit,
        );
      }
      const p = row.payload;
      const pending = current.pendingResponse;
      if (pending === null || pending.responseId !== p.responseId) {
        return refuse(
          'dangling-binding',
          `intent names response ${p.responseId}, pending is ${pending?.responseId ?? 'none'}`,
          commit,
        );
      }
      const pendingIntents = byId(Object.entries(current.pendingIntents));
      for (const callId of p.callIds) {
        const call = pending.calls.find((fact) => fact.callId === callId);
        if (call === undefined || call.parallelSafe) {
          return refuse(
            'dangling-binding',
            `intent names ${callId}, which is not a barrier call of ${p.responseId}`,
            commit,
          );
        }
        const known = pendingIntents[callId];
        if (known !== undefined && p.attempt < known.attempt) {
          return refuse(
            'out-of-order',
            `intent attempt ${p.attempt} is below ${known.attempt} for ${callId}`,
            commit,
          );
        }
        pendingIntents[callId] = {
          attempt: p.attempt,
          responseId: p.responseId,
          approvalRequestId:
            known !== undefined && known.attempt === p.attempt
              ? known.approvalRequestId
              : null,
        };
      }
      return Result.succeed({
        ...current,
        commit,
        rowsBeforeSnapshot: current.rowsBeforeSnapshot + 1,
        pendingIntents,
      });
    }
    case 'tool.result': {
      if (!opened(current)) {
        return refuse(
          'out-of-order',
          `${row.type} before the opening flow.snapshot`,
          commit,
        );
      }
      const p = row.payload;
      const pending = current.pendingResponse;
      if (
        pending === null ||
        pending.responseId !== p.responseId ||
        !pending.calls.some((call) => call.callId === p.callId)
      ) {
        return refuse(
          'orphan-settlement',
          `${p.callId} settles no pending call of ${p.responseId}`,
          commit,
        );
      }
      const previous = pending.settled[p.callId];
      if (previous !== undefined && previous.attempt === p.attempt) {
        return refuse(
          'orphan-settlement',
          `${p.callId} is already settled at attempt ${p.attempt}`,
          commit,
        );
      }
      if (previous !== undefined && previous.attempt > p.attempt) {
        return refuse(
          'out-of-order',
          `${p.callId} attempt ${p.attempt} is below ${previous.attempt}`,
          commit,
        );
      }
      // A pending intent is this call's outcome-unknown barrier, and only the
      // attempt it admitted can close it. Accepting another attempt's
      // settlement leaves the intent standing until the delivering append
      // drops every intent of the response, which retires the uncertainty
      // with no re-run decision anywhere in the rows.
      const intent = current.pendingIntents[p.callId];
      if (intent !== undefined && intent.attempt !== p.attempt) {
        return refuse(
          'out-of-order',
          `${p.callId} settles attempt ${p.attempt} while its intent admitted attempt ${intent.attempt}`,
          commit,
        );
      }
      const pendingIntents =
        intent === undefined
          ? current.pendingIntents
          : byId(
              Object.entries(current.pendingIntents).filter(
                ([callId]) => callId !== p.callId,
              ),
            );
      return applyMutations(
        {
          ...current,
          commit,
          rowsBeforeSnapshot: current.rowsBeforeSnapshot + 1,
          pendingResponse: {
            ...pending,
            settled: byId([
              ...Object.entries(pending.settled),
              [
                p.callId,
                {
                  attempt: p.attempt,
                  disposition: p.disposition,
                  duplicateOf: p.duplicateOf,
                  result: p.result,
                  attachments: p.attachments,
                },
              ],
            ]),
          },
          pendingIntents,
        },
        p.stateMutation,
        commit,
      );
    }
    case 'tool.start':
    case 'tool.end':
    case 'stream.end':
      // Committed with its `tool.result` or its `waiting` step; the ledger
      // row beside it is the fact.
      return null;
    case 'request.opened': {
      if (current === null) return null;
      if (Object.hasOwn(current.requests, row.requestId)) {
        return refuse(
          'out-of-order',
          `request ${row.requestId} opened twice`,
          commit,
        );
      }
      return Result.succeed({
        ...current,
        commit,
        requests: byId([
          ...Object.entries(current.requests),
          [
            row.requestId,
            { payload: row.payload, resolved: false, decision: null },
          ],
        ]),
      });
    }
    case 'request.decided': {
      if (current === null) return null;
      const request = current.requests[row.requestId];
      if (request === undefined) {
        return refuse(
          'dangling-binding',
          `decision names no request ${row.requestId}`,
          commit,
        );
      }
      return Result.succeed({
        ...current,
        commit,
        requests: byId([
          ...Object.entries(current.requests),
          [
            row.requestId,
            { ...request, resolved: true, decision: row.decision },
          ],
        ]),
      });
    }
    default:
      if (IGNORED.has(row.type)) return null;
      return refuse('unknown-run-row', row.type, commit);
  }
}

/**
 * `rows` must be strictly increasing in `commit`; the fold does not reorder
 * them. `state` is `null` for a cold fold and the previous level for an
 * incremental one, and the two are the same computation: that equality is
 * what the ledger test pins. `null` out means no ledger row has folded.
 *
 * Returns a typed inconsistency rather than throwing or defaulting: a
 * snapshot that disagrees with the rows below it is corruption, not a state
 * to degrade into.
 */
export function foldRunState(
  state: RunState | null,
  rows: readonly SessionEvent[],
): Result.Result<RunState | null, RunLedgerInconsistent> {
  let current = state;
  for (const row of rows) {
    const next = foldRow(current, row);
    if (next === null) continue;
    if (Result.isFailure(next)) return next;
    current = next.success;
  }
  return Result.succeed(current);
}
