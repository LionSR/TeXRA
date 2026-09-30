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
  type TurnResult,
} from '@texra-ai/llm/turn';
import {
  addTurnUsage,
  EMPTY_RUN_USAGE_TOTALS,
  RunSnapshotPayloadSchema,
  requestParksItsCaller,
  type CommitOrdinal,
  type DispatchFacts,
  type HookOutcomes,
  type InvocationRef,
  type JsonValue,
  type ModelCompatibilityKey,
  type OfferedTool,
  type PendingRetry,
  type RunSnapshotPayload,
  type RetryErrorInfo,
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
  copyById,
  freshRunPosition,
  isFollowUpRow,
  isSharedRunRow,
  phaseAfter,
  type RunLoopPhase,
  type FoldPass,
  type RunPosition,
  type SharedRunRow,
  writable,
} from './runRows';
import { openAttemptAfter, type OpenAttempt } from './openAttempt';
import { mutate } from './stateOperation';
import type { HistoryMessage, Live, RunLedgerRow } from './ledgerTurns';
import type { z } from 'zod';

/**
 * The rows `RunLedger.appendBatch` commits: the six ledger arms plus the
 * display arms a batch has to commit atomically with them. A tool call's card
 * settles with its `tool.result` (`tool.end` for a card the dispatcher already
 * opened, both card rows for a fast tool whose card opens and closes in that
 * batch); an approval's recovery binding is the `tool.binding` committed in
 * the same batch; a streaming row open when the loop parks closes with the
 * `waiting` step; a model switch's `run.config` restates the snapshot's
 * model id. Publishing those companions separately is the crash
 * window where a settled tool keeps an active card, or a terminal card claims
 * a result no row holds, or an approval survives with nothing to recover it
 * by, or a listing names a model the ledger does not. An explicit list
 * narrowed from `SessionEventDraft`, never `SessionEventDraft` itself.
 */
export type RunLedgerDraft = Live<
  Extract<SessionEventDraft, { type: RunLedgerDraftType }>
>;
type RunLedgerDraftType =
  | 'run.position'
  | 'model.message'
  | 'model.compaction'
  | 'tool.intent'
  | 'tool.binding'
  | 'tool.result'
  | 'model.retry'
  | 'run.snapshot'
  | 'tools.offered'
  | 'context.blob'
  | 'hook.outcome'
  | 'output.produced'
  | 'tool.start'
  | 'tool.end'
  | 'stream.end'
  | 'request.opened'
  | 'request.decided'
  | 'followup.consumed';

export class RunLedgerInconsistent extends Data.TaggedError(
  'RunLedgerInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing, or a row before the row it presupposes
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'mismatched-delivery' // a delivering append does not settle its response
    | 'invalid-mutation' // a tool.result state operation names no slice or leaves an invalid state
    | 'unreadable-turn'; // a stored turn this build of the package cannot parse
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}

/** The loop state a `run.snapshot` restores. */
const LoopStateSchema = RunSnapshotPayloadSchema.shape.state;
type LoopState = z.output<typeof LoopStateSchema>;

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
  /** Model calls: a new invocation's `attempt` row counts one, a retry none. */
  readonly round: number;
  /** The last folded row. */
  readonly commit: CommitOrdinal;
  /** The latest `run.snapshot` as written: the loop state beside it moves
   *  with each `tool.result` mutation, this does not. */
  readonly lastSnapshot: RunSnapshotPayload | null;
  /** Ledger rows folded into this state, before and after any snapshot:
   *  zero means only queued input has folded (an unopened, not broken, run). */
  readonly ledgerRows: number;
  /** `null` until the opening `run.snapshot` (then `initial`, moved by
   *  {@link phaseAfter}): no row that presupposes an opened run precedes it. */
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
  readonly messages: readonly HistoryMessage[];
  readonly continuation: Continuation | null;
  readonly openAttempt: OpenAttempt | null;
  /** The last completed turn, from its `response` row: the finish reason a
   *  loop reads when it processes a response it did not just receive. */
  readonly lastTurn: TurnResult | null;
  readonly pendingResponse: PendingResponse | null;
  /** By call id. */
  readonly pendingIntents: Readonly<Record<string, PendingIntent>>;
  /** Derived (D12): the priced usage on every `response` and `model.compaction`
   *  row plus `tool.result` `add` operations. No snapshot carries it. */
  readonly usage: RunUsageTotals;
  /** The turn the last `context-window` compaction (one per round) hit. */
  readonly overflowRecoveredAtTurn: number | null;
  readonly loop: LoopState | null;
  /** The latest `tools.offered` row's set; `null` before the first. */
  readonly offeredTools: readonly OfferedTool[] | null;
  /** The plugin whose continuation the latest `tools.offered` row pinned. */
  readonly offeredContinuation: string | null;
  /** The names of the skills it listed. */
  readonly offeredSkills: readonly string[];
  /** The address of the system text the run's context froze. */
  readonly offeredSystem: string | null;
  /** The address of the context its model has been told; `null` before the
   *  first step and after a compaction, which each open it anew. */
  readonly offeredContext: string | null;
  readonly offeredHooks: readonly string[]; // the hooks it pinned
  /** The run's `context.blob` rows: model-facing content by address. */
  readonly contents: Readonly<Record<string, JsonValue>>;
  /** The `hook.outcome` rows by point: a recorded point never runs again. */
  readonly hookOutcomes: HookOutcomes;
};

/** Companions committed beside the ledger fact; the loop ignores them. */
type CardRowType = 'tool.start' | 'tool.end' | 'stream.end';

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
  'run.model': true,
  'run.detach': true,
  'run.end': true,
  'run.removed': true,
  'run.description': true,
  'run.trash': true,
  'conversation.progress': true,
  'run.fact': true,
  'child.park': true,
  'plugin.fact': true,
  inquiryThreadUpdated: true,
  'approval.policy': true,
  log: true,
  'stage.start': true,
  'stage.end': true,
  'workflow.plan': true,
  'workflow.call': true,
  usage: true,
  'context.state': true,
  'stream.start': true,
  'response.finalized': true,
  'run.report': true,
  'run.result': true,
  'followup.closed': true,
  // The child loop's own bookkeeping: folded by its readers, not the loop.
  'child.turn': true,
  // Checkpoint-aggregate rows never reach a run fold; total-record members.
  'workflow.script': true,
  'workflow.journal': true,
  'workflow.attempt': true,
};
const IGNORED = new Set<string>(Object.keys(IGNORED_ROW_TYPES));

/** The state a run starts from: every field at its zero, no family bound
 *  yet. The run program opens from this and stamps its family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  ...freshRunPosition(),
  round: 0,
  commit,
  lastSnapshot: null,
  ledgerRows: 0,
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
  loop: null,
  overflowRecoveredAtTurn: null,
  offeredTools: null,
  offeredContinuation: null,
  offeredSkills: [],
  offeredSystem: null,
  offeredContext: null,
  offeredHooks: [],
  contents: {},
  hookOutcomes: {},
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

/**
 * Apply a settlement's operations over the loop `state` (the only slice a
 * call may set; `StateOperationSchema` refuses any other path), and
 * re-validate it through its schema so the state stays typed without a cast.
 */
function applyMutations(
  state: RunState,
  ops: readonly StateOperation[],
  commit: CommitOrdinal,
): Fold {
  if (ops.length === 0) return Result.succeed(state);
  let document: unknown = { state: state.loop };
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
  if (state.loop === null) {
    return document.state === null
      ? Result.succeed(state)
      : refuse('invalid-mutation', 'no loop state to mutate', commit);
  }
  const loop = LoopStateSchema.safeParse(document.state);
  if (!loop.success) {
    return refuse('invalid-mutation', loop.error.message, commit);
  }
  return Result.succeed({ ...state, loop: loop.data });
}

const opened = (state: RunState | null): state is RunState =>
  state !== null && state.phase !== null;

function foldRow(
  current: RunState | null,
  row: RunLedgerRow,
  pass: FoldPass,
): Fold | null {
  const commit = row.commit;
  /** `messages` with `added` appended: the pass's own array, written once
   *  copied, so a batch of rows appends without re-copying the history. */
  const appended = (state: RunState, ...added: readonly HistoryMessage[]) => {
    const messages = writable(pass, state.messages, (m) => [...m]);
    for (const message of added) messages.push(message);
    return messages;
  };
  /** A row out of the order the ledger writes. */
  const outOfOrder = (detail: string) => refuse('out-of-order', detail, commit);
  if (current !== null && commit <= current.commit) {
    return outOfOrder(`commit ${commit} is not above ${current.commit}`);
  }
  /** A row that presupposes the opening snapshot, folded before it. */
  const beforeOpening = (what: string) =>
    outOfOrder(`${what} before the opening run.snapshot`);
  /** The state with this ledger row counted in. */
  const advance = (state: RunState): RunState => ({
    ...state,
    commit,
    ledgerRows: state.ledgerRows + 1,
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
      return outOfOrder('output before opening snapshot');
    }
    const verdict = applyRunRow(current, row, pass);
    if (verdict.kind === 'unchanged') return null;
    if (verdict.kind === 'unresolved') {
      return outOfOrder(`decision names no request ${verdict.requestId}`);
    }
    if (verdict.kind === 'contradiction') return outOfOrder(verdict.detail);
    const state = current ?? freshRunState(commit);
    const at = verdict.rows.at;
    return Result.succeed({
      ...state,
      commit,
      // Only the loop's own position is a ledger row; queued input, output
      // and the requests a session opens do not open a run.
      ledgerRows: state.ledgerRows + (at === undefined ? 0 : 1),
      ...verdict.rows,
      phase: phaseAfter(state.phase, at),
    });
  }
  switch (row.type) {
    case 'run.snapshot': {
      // The loop state and what the loop runs on, and nothing else: no
      // position and no reference set, so there is no way for a snapshot to
      // disagree with the rows below it (single-owner note, section 3.3).
      const p = row.payload;
      const state = current ?? freshRunState(commit);
      return Result.succeed({
        ...advance(state),
        lastSnapshot: p,
        phase: state.phase ?? 'initial',
        family: p.family,
        ...p.runtime,
        loop: p.state,
      });
    }
    case 'model.message': {
      const p = row.payload;
      if (p.kind === 'append' && p.sourceResponse === null) {
        const state = current ?? freshRunState(commit);
        return Result.succeed({
          ...advance(state),
          messages: appended(state, ...p.messages),
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
            return outOfOrder(
              `attempt ${p.invocation.attempt} does not follow ${open.invocation.attempt}`,
            );
          }
          return Result.succeed({
            ...state,
            phase: 'model.submitted',
            round: p.invocation.attempt === 1 ? state.round + 1 : state.round,
            openAttempt: {
              invocation: p.invocation,
              request: p.request,
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
        case 'cancelled':
        case 'response': {
          const open = state.openAttempt;
          if (open === null || !sameInvocation(open.invocation, p.invocation)) {
            return outOfOrder(`${p.kind} names no open attempt`);
          }
          if (p.kind !== 'response') {
            const next = openAttemptAfter(open, p);
            return typeof next === 'string'
              ? outOfOrder(next)
              : Result.succeed({ ...state, openAttempt: next });
          }
          if (state.pendingResponse !== null) {
            return outOfOrder(
              `response ${p.responseId} while ${state.pendingResponse.responseId} is undelivered`,
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
              messages: appended(settled, assistantMessageFromResult(p.turn)),
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
          const pendingIntents = byId(
            Object.entries(state.pendingIntents).filter(
              ([, intent]) => intent.responseId !== pending.responseId,
            ),
          );
          pass.add(pendingIntents);
          return Result.succeed({
            ...state,
            messages: appended(
              state,
              assistantMessageFromResult(pending.turn),
              ...p.messages,
            ),
            pendingResponse: null,
            pendingIntents,
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
      const messages = [
        ...current.messages.slice(0, p.keepPrefix),
        ...p.messages,
      ];
      pass.add(messages);
      return Result.succeed({
        ...advance(current),
        messages,
        continuation: p.continuation,
        // The next step renders the system text anew, every change in it.
        offeredSystem: null,
        offeredContext: null,
        usage: addTurnUsage(current.usage, p.usage),
        ...(p.cause === 'context-window'
          ? { overflowRecoveredAtTurn: current.turn }
          : {}),
      });
    }
    case 'tool.intent': {
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      if (pending === null || pending.responseId !== p.responseId) {
        return outOfOrder(
          `intent names response ${p.responseId}, pending is ${pending?.responseId ?? 'none'}`,
        );
      }
      const pendingIntents = writable(pass, current.pendingIntents, copyById);
      for (const callId of p.callIds) {
        const call = pending.calls.find((fact) => fact.callId === callId);
        if (call === undefined) {
          return outOfOrder(
            `intent names ${callId}, which is not a call of ${p.responseId}`,
          );
        }
        const known = pendingIntents[callId];
        if (known !== undefined && p.attempt < known.attempt) {
          return outOfOrder(
            `intent attempt ${p.attempt} is below ${known.attempt} for ${callId}`,
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
        return outOfOrder(
          `binding ${p.requestId} names no pending intent for ${p.callId} at attempt ${p.attempt}`,
        );
      }
      const pendingIntents = writable(pass, current.pendingIntents, copyById);
      pendingIntents[p.callId] = { ...intent, approvalRequestId: p.requestId };
      return Result.succeed({ ...advance(current), pendingIntents });
    }
    case 'tools.offered': // a fresh run's comes in its opening batch
      return Result.succeed({
        ...advance(current ?? freshRunState(commit)),
        offeredTools: row.payload.tools,
        offeredContinuation: row.payload.continuation,
        offeredSkills: row.payload.skills,
        offeredSystem: row.payload.system,
        offeredContext: row.payload.context,
        offeredHooks: row.payload.hooks,
      });
    case 'context.blob': {
      const { digest, value } = row.payload;
      const state = advance(current ?? freshRunState(commit));
      // A digest is 64 hex characters, never `__proto__`: plain assignment.
      const contents = writable(pass, state.contents, (c) => ({ ...c }));
      contents[digest] = value;
      return Result.succeed({ ...state, contents });
    }
    case 'hook.outcome': {
      // An opening batch carries its opening hooks: no opened run needed.
      const p = row.payload;
      const state = advance(current ?? freshRunState(commit));
      const byPoint = writable(pass, state.hookOutcomes, (h) => ({ ...h }));
      byPoint[p.point] = [...(byPoint[p.point] ?? []), p];
      return Result.succeed({ ...state, hookOutcomes: byPoint });
    }
    case 'model.retry': {
      if (!opened(current)) return beforeOpening(row.type);
      const permit = row.payload.permit;
      // A permit presupposes the request.opened it names.
      if (permit !== null && current.requests[permit.requestId] === undefined) {
        return outOfOrder(`dangling ${permit.requestId}`);
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
        return outOfOrder(
          `${p.callId} attempt ${p.attempt} is below ${previous.attempt}`,
        );
      }
      // A pending intent is this call's outcome-unknown barrier, and only the
      // attempt it admitted can close it. Accepting another attempt's
      // settlement leaves the intent standing until the delivering append
      // drops every intent of the response, which retires the uncertainty
      // with no re-run decision anywhere in the rows.
      const intent = current.pendingIntents[p.callId];
      if (intent !== undefined && intent.attempt !== p.attempt) {
        return outOfOrder(
          `${p.callId} settles attempt ${p.attempt} while its intent admitted attempt ${intent.attempt}`,
        );
      }
      let pendingIntents = current.pendingIntents;
      if (intent !== undefined) {
        const remaining = writable(pass, pendingIntents, copyById);
        delete remaining[p.callId];
        pendingIntents = remaining;
      }
      const settled = writable(pass, pending.settled, copyById);
      settled[p.callId] = {
        attempt: p.attempt,
        disposition: p.disposition,
        duplicateOf: p.duplicateOf,
        result: p.result,
        attachments: p.attachments,
      };
      return applyMutations(
        {
          ...advance(current),
          pendingResponse: { ...pending, settled },
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
  rows: readonly RunLedgerRow[],
): Result.Result<RunState | null, RunLedgerInconsistent> {
  let current = state;
  const pass: FoldPass = new WeakSet();
  for (const row of rows) {
    const next = foldRow(current, row, pass);
    if (next === null) continue;
    if (Result.isFailure(next)) return next;
    current = next.success;
  }
  return Result.succeed(current);
}
