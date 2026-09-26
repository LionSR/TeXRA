/**
 * Pure run-state replay for ledger load, appendBatch, and the trace stepper:
 * state at a commit is exactly the state resume continues from, without IO,
 * clocks, platform reads, synthetic ids, or output-order dependence on Maps.
 * sessionFold produces the view; this fold produces the loop's continuation.
 */
import { Data, Result } from 'effect';

import {
  assistantMessageFromResult,
  type Continuation,
  type MessageSchema,
  type ModelOrigin,
  type RemoteOperation,
  type TurnResult,
} from '@texra-ai/llm/turn';
import {
  addTurnUsage,
  EMPTY_RUN_USAGE_TOTALS,
  FlowSnapshotPayloadSchema,
  RunUsageTotalsSchema,
  requestParksItsCaller,
  type CommitOrdinal,
  type FlowSnapshotPayload,
  type DispatchFacts,
  type InvocationRef,
  type ModelCompatibilityKey,
  type PendingRetry,
  type RetryErrorInfo,
  type RunLoopPhase,
  type RunUsageTotals,
  type SessionEvent,
  type SessionEventDraft,
  type SnapshotRuntime,
  type StateOperation,
  type ToolResultPayload,
} from '@shared/schemas';
import { isObject } from '@utils/core';
import {
  applyRunRow,
  byId,
  freshRunPosition,
  isFollowUpRow,
  isSharedRunRow,
  type RunPosition,
  type SharedRunRow,
} from './runRows';
import type { z } from 'zod';

/**
 * The rows `RunLedger.appendBatch` commits: the six ledger arms plus the
 * display arms a batch has to commit atomically with them. A tool call's card
 * settles with its `tool.result` (`tool.end` for a card the dispatcher already
 * opened, both card rows for a fast tool whose card opens and closes in that
 * batch); an approval's recovery binding is the `tool.binding` committed in
 * the same batch; a streaming row open when the loop parks closes with the
 * `waiting` step; a model switch's `run.record` and `run.config` restate the
 * snapshot's model id. Publishing those companions separately is the crash
 * window where a settled tool keeps an active card, or a terminal card claims
 * a result no row holds, or an approval survives with nothing to recover it
 * by, or a listing names a model the ledger does not. An explicit list
 * narrowed from `SessionEventDraft`, never `SessionEventDraft` itself.
 */
export type RunLedgerDraft = Extract<
  SessionEventDraft,
  {
    type:
      | 'flow.step'
      | 'model.message'
      | 'model.compaction'
      | 'tool.intent'
      | 'tool.binding'
      | 'tool.result'
      | 'model.retry'
      | 'flow.snapshot'
      | 'output.produced'
      | 'tool.start'
      | 'tool.end'
      | 'stream.end'
      | 'request.opened'
      | 'request.decided'
      | 'followup.consumed'
      | 'run.record'
      | 'run.config';
  }
>;

export class RunLedgerInconsistent extends Data.TaggedError(
  'RunLedgerInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing, or a row before the row it presupposes
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
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
type Message = z.output<typeof MessageSchema>;

/**
 * The family state of a snapshot, keeping the family/state correlation. The
 * two arms are spelled out deliberately, though the text is the same: the
 * test narrows the discriminated payload so that `state` keeps the arm its
 * `family` names. Collapsing them widens the pair to a shape `FlowState`
 * does not accept, so the identical arms are load-bearing, not a leftover.
 */
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
   *  `tool.binding` row in the approval's batch is its only carrier. */
  readonly approvalRequestId: string | null;
};

/**
 * What the loop continues from. A plain type with no schema of its own,
 * because giving it one invites persisting it (C10). Every field is derived
 * from the row that produced it.
 */
export type RunState = RunPosition & {
  /** The last folded row. */
  readonly commit: CommitOrdinal;
  readonly snapshotCommit: CommitOrdinal | null;
  /** Ledger rows folded into this state: zero means nothing but queued
   *  input has folded, which is what tells an unopened run from a broken one. */
  readonly rowsBeforeSnapshot: number;
  /** `null` until the opening `flow.snapshot`: no row that presupposes an
   *  opened run folds before it. */
  readonly phase: RunLoopPhase | null;
  readonly modelId: string | null;
  readonly modelCompatibilityKey: ModelCompatibilityKey | null;
  readonly lastError: RetryErrorInfo | null;
  /** The human retry permit, as the last `model.retry` row left it. */
  readonly pendingRetry: PendingRetry | null;
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
  /** Derived (D12): the priced usage stamped on every `response` row plus
   *  `tool.result` `add` operations. No snapshot carries it. */
  readonly usage: RunUsageTotals;
  /** Where the last `context-window` compaction (one per round) landed. */
  readonly overflowRecoveredAt: Pick<RunPosition, 'round' | 'turn'> | null;
  readonly flow: FlowState | null;
};

/** Companions committed beside the ledger fact; the loop ignores them. */
type CardRowType =
  'tool.start' | 'tool.end' | 'stream.end' | 'run.record' | 'run.config';

/** The rows `foldRow` applies: the shared rows and the ledger's own arms. */
type FoldedRowType =
  SharedRunRow['type'] | Exclude<RunLedgerDraft['type'], CardRowType>;

/**
 * Display rows ignored by name. Anything on the run aggregate that is neither
 * here nor a folded row is `unknown-run-row`, never a quiet `default`. The
 * record is total over the event vocabulary, so a new display arm is a
 * compile error here until it is classified.
 */
const IGNORED_ROW_TYPES: Readonly<
  Record<Exclude<SessionEvent['type'], FoldedRowType>, true>
> = {
  'tool.start': true,
  'tool.end': true,
  'stream.end': true,
  'run.start': true,
  'run.activate': true,
  'run.config': true,
  'run.detach': true,
  'run.end': true,
  'run.removed': true,
  'run.description': true,
  'conversation.progress': true,
  'run.fact': true,
  'child.park': true,
  goalStateChanged: true,
  inquiryThreadUpdated: true,
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
  'run.report': true,
  'run.result': true,
  'run.workspaceFiles': true,
  // The child loop's own bookkeeping: folded by its readers, not the loop.
  'child.turn': true,
  // Checkpoint-aggregate rows never reach a run fold; total-record members.
  'workflow.script': true,
  'workflow.journal': true,
  'workflow.attempt': true,
  'state.value.set': true,
};
const IGNORED = new Set<string>(Object.keys(IGNORED_ROW_TYPES));

/** The state a run starts from: every field at its zero, no family bound
 *  yet. Both run programs open from this and stamp their own family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  ...freshRunPosition(),
  commit,
  snapshotCommit: null,
  rowsBeforeSnapshot: 0,
  phase: null,
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
  usage: EMPTY_RUN_USAGE_TOTALS,
  flow: null,
  overflowRecoveredAt: null,
});

/**
 * The undecided requests nothing can recover: no binding names them, and
 * they are not the one kind that outlives the process that asked. A request
 * the session opened for a tool (a command, an edit, a plan, a delegation,
 * a question) parks that tool, so a new owner can neither answer it nor
 * re-ask it, so a resume retires them as cancelled before it continues the
 * run (`RunLedger.acquire`). An `externalInquiry` is the exception by contract:
 * its tool returns at once and its answer arrives as a follow-up, whichever
 * process is running the run by then, so it stands unbound across every
 * snapshot its run writes.
 */
export function unboundRequests(state: RunState): readonly string[] {
  // The recovery bindings the rows carry (R5): the `model.retry` permit's
  // request and every pending intent's `tool.binding`.
  const bindings = new Set<string | null>(
    Object.values(state.pendingIntents).map((i) => i.approvalRequestId),
  );
  if (state.pendingRetry !== null) bindings.add(state.pendingRetry.requestId);
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
  /** A row that presupposes the opening snapshot, folded before it. */
  const beforeOpening = (what: string) =>
    refuse('out-of-order', `${what} before the opening flow.snapshot`, commit);
  /** The state with this ledger row counted in. */
  const advance = (state: RunState): RunState => ({
    ...state,
    commit,
    rowsBeforeSnapshot: state.rowsBeforeSnapshot + 1,
  });
  // Pending input is the publisher's: a queued row only opens an empty run.
  if (isFollowUpRow(row))
    return current === null && row.type === 'followup.queued'
      ? Result.succeed(freshRunState(commit))
      : null;
  if (isSharedRunRow(row)) {
    // The rows `sessionFold` reads too: applied once, in `runRows.ts`.
    // `unresolved` is a malformed aggregate here: this fold reads a run's
    // whole history, so a decision always follows the opening it answers.
    if (row.type === 'output.produced' && !opened(current)) {
      return refuse('out-of-order', 'output before opening snapshot', commit);
    }
    const verdict = applyRunRow(current, row);
    if (verdict.kind === 'unchanged') return null;
    if (verdict.kind === 'unresolved') {
      return refuse(
        'out-of-order',
        `decision names no request ${verdict.requestId}`,
        commit,
      );
    }
    if (verdict.kind === 'contradiction') {
      return refuse('out-of-order', verdict.detail, commit);
    }
    const state = current ?? freshRunState(commit);
    return Result.succeed({
      ...state,
      commit,
      // Only the loop's own step is a ledger row; queued input, output and
      // the requests a session opens do not open a run.
      rowsBeforeSnapshot:
        state.rowsBeforeSnapshot + (verdict.rows.step === undefined ? 0 : 1),
      ...verdict.rows,
    });
  }
  switch (row.type) {
    case 'flow.snapshot': {
      // Family state and the coordinates the loop owns, and nothing else: no
      // reference set to reconcile, so there is no way for a snapshot to
      // disagree with the rows below it (single-owner note, section 3.3).
      const p = row.payload;
      const state = current ?? freshRunState(commit);
      if (state.family !== null && state.family !== p.family) {
        return refuse('out-of-order', 'a snapshot of another family', commit);
      }
      return Result.succeed({
        ...advance(state),
        snapshotCommit: commit,
        family: p.family,
        ...p.runtime,
        flow: flowOf(p),
      });
    }
    case 'model.message': {
      const p = row.payload;
      if (p.kind === 'append' && p.sourceResponse === null) {
        const state = current ?? freshRunState(commit);
        return Result.succeed({
          ...advance(state),
          messages: [...state.messages, ...p.messages],
        });
      }
      if (!opened(current)) return beforeOpening(`${row.type} ${p.kind}`);
      const state = advance(current);
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
              'out-of-order',
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
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      return Result.succeed({
        ...advance(current),
        messages: [...current.messages.slice(0, p.keepPrefix), ...p.messages],
        continuation: p.continuation,
        ...(p.cause === 'context-window'
          ? {
              overflowRecoveredAt: { round: current.round, turn: current.turn },
            }
          : {}),
      });
    }
    case 'tool.intent': {
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      if (pending === null || pending.responseId !== p.responseId) {
        return refuse(
          'out-of-order',
          `intent names response ${p.responseId}, pending is ${pending?.responseId ?? 'none'}`,
          commit,
        );
      }
      const pendingIntents = byId(Object.entries(current.pendingIntents));
      for (const callId of p.callIds) {
        const call = pending.calls.find((fact) => fact.callId === callId);
        if (call === undefined || call.parallelSafe) {
          return refuse(
            'out-of-order',
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
        ...advance(current),
        pendingIntents,
      });
    }
    case 'tool.binding': {
      if (!opened(current)) return beforeOpening(row.type);
      // The approval that guards one outcome-unknown call, committed with
      // the `request.opened` it names: the intent it binds is the one the
      // rows already hold, at the attempt the approval admits.
      const p = row.payload;
      const intent = current.pendingIntents[p.callId];
      if (intent === undefined || intent.attempt !== p.attempt) {
        return refuse(
          'out-of-order',
          `binding ${p.requestId} names no pending intent for ${p.callId} at attempt ${p.attempt}`,
          commit,
        );
      }
      return Result.succeed({
        ...advance(current),
        pendingIntents: byId([
          ...Object.entries(current.pendingIntents),
          [p.callId, { ...intent, approvalRequestId: p.requestId }],
        ]),
      });
    }
    case 'model.retry': {
      if (!opened(current)) return beforeOpening(row.type);
      const permit = row.payload.permit;
      // A permit presupposes the request.opened it names.
      if (permit !== null && current.requests[permit.requestId] === undefined) {
        return refuse('out-of-order', `dangling ${permit.requestId}`, commit);
      }
      // The retry owner's durable gate, its one carrier: `null` retires it.
      return Result.succeed({
        ...advance(current),
        pendingRetry: permit,
      });
    }
    case 'tool.result': {
      if (!opened(current)) return beforeOpening(row.type);
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
          ...advance(current),
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
 * Returns a typed inconsistency rather than throwing or defaulting: a row
 * the fold cannot apply is corruption, not a state to degrade into. A
 * snapshot restates no row fact, so it cannot disagree with the rows.
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
