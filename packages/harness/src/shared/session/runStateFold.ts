/**
 * Pure run-state replay for run history load, appendBatch, and the trace stepper:
 * state at a commit is exactly the state resume continues from, without IO,
 * clocks, platform reads, synthetic ids, or output-order dependence on Maps.
 * sessionFold produces the view; this fold produces the loop's continuation.
 */
import { Data, Result } from 'effect';

import {
  assistantMessageFromResult,
  type Continuation,
  type TurnResult,
} from '@texra-ai/llm';
import {
  addTurnUsage,
  EMPTY_RUN_USAGE_TOTALS,
  requestParksItsCaller,
  type CommitOrdinal,
  type HookOutcomes,
  type JsonValue,
  type ModelBackend,
  type DeclinableUsageRoute,
  type OfferedTool,
  type RetryErrorInfo,
  type RunInput,
  type RunUsageTotals,
  type SessionEvent,
  type SessionEventDraft,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '@shared/schemas';
import {
  applyRunRow,
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
import {
  attemptOf,
  boundRequestOf,
  invocationAfter,
  pendingResponseOf,
  settlementOf,
  type Invocation,
  type PendingCall,
  type PendingResponse,
} from './inFlight';
import type { HistoryMessage, Live, RunHistoryRow } from './historyTurns';

/**
 * The rows `RunHistory.appendBatch` commits: the six run history arms plus the
 * display arms a batch has to commit atomically with them. A tool call's card
 * settles with its `tool.result`; an approval's recovery binding is the
 * `tool.binding` in the same batch; a streaming row open when the loop parks
 * closes with the `waiting` step; a run's binding and a model switch are its
 * `run.config`; a child turn's settlement commits with its boundary.
 * Publishing those companions separately is the crash window where a settled
 * tool keeps an active card, a card claims a result no row holds, an approval
 * has nothing to recover it by, or a listing names a model the history does
 * not. An explicit list narrowed from `SessionEventDraft`.
 */
export type RunHistoryDraft = Live<
  Extract<SessionEventDraft, { type: RunHistoryDraftType }>
>;
type RunHistoryDraftType =
  | 'run.position'
  | 'model.message'
  | 'context.edit'
  | 'tool.intent'
  | 'script.call'
  | 'tool.binding'
  | 'tool.result'
  | 'run.config'
  | 'tools.offered'
  | 'context.blob'
  | 'hook.outcome'
  | 'tool.start'
  | 'tool.end'
  | 'stream.end'
  | 'request.opened'
  | 'request.decided'
  | 'followup.consumed'
  | SettlementType;

export class RunHistoryInconsistent extends Data.TaggedError(
  'RunHistoryInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing, or a row before the row it presupposes
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'mismatched-delivery' // a delivering append does not settle its response
    | 'unreadable-turn'; // a stored turn this build of the package cannot parse
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}

/**
 * What the loop continues from. A plain type with no schema of its own,
 * because giving it one invites persisting it (C10). Every field is derived
 * from the row that produced it.
 */
export type RunState = RunPosition & {
  /** Responses: a new turn invocation's `attempt` row counts one, a retry
   *  none, and a script run's `handed-down` call one. */
  readonly round: number;
  /** The last folded row. */
  readonly commit: CommitOrdinal;
  /** Run history rows folded into this state: zero means only queued input
   *  has folded (an unopened, not broken, run). */
  readonly runHistoryRows: number;
  /** `null` until the opening `run.position` (then moved by
   *  {@link phaseAfter}): no row that presupposes an opened run precedes it. */
  readonly phase: RunLoopPhase | null;
  /** The model the run is on: its newest `run.config`'s. */
  readonly modelId: string | null;
  /** The backend that config's `binding` names; null before the run binds. */
  readonly backend: ModelBackend | null;
  /** The failure that stopped the turn's invocation or that a person was
   *  asked about, until a response or the input of a new turn retires it. */
  readonly lastError: RetryErrorInfo | null;
  /** Subscription routes this run declines: the launch's seed, on its
   *  `run.config` binding, plus each retry the user answered with their own
   *  API key, folded from that answer. */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /** Canonical provider history, in order. The pending response's assistant
   *  message enters only with its delivering `append`. */
  readonly messages: readonly HistoryMessage[];
  readonly continuation: Continuation | null;
  /** The turn's model invocation, from its first attempt until its response
   *  or the next turn's input. */
  readonly invocation: Invocation | null;
  /** The last completed turn, from its `response` row: the finish reason a
   *  loop reads when it processes a response it did not just receive. */
  readonly lastTurn: TurnResult | null;
  /** An edit changed the view's messages since `lastTurn`: its count
   *  measures a history the view no longer holds. An edit of an empty range
   *  (a model switch) leaves it. */
  readonly countStale: boolean;
  readonly pendingResponse: PendingResponse | null;
  /** The requests decided since the run's latest `run.activate`: answers
   *  this owner landed before its loop reached the call waiting on them, so
   *  no waiter has read them. A decision from before the activation was
   *  read by the process that asked, whose body went on with it. */
  readonly decidedSinceActivation: ReadonlySet<string>;
  /** Derived (D12): the priced usage on every `response` and `context.edit`
   *  row. */
  readonly usage: RunUsageTotals;
  /** The workspace files the run's calls edited, first edit first: the
   *  paths of every executed `tool.result`'s `edits`. */
  readonly edited: readonly string[];
  /** Settlements `executed` or `failed`: tool bodies and script host answers. */
  readonly toolCalls: number;
  /** The latest `context.edit`'s `seq`: the next edit's `base`. */
  readonly lastEdit: number | null;
  /** What the run's turns answer besides their messages: the latest value
   *  of each field an `append` or a fork's edit recorded; an instruction
   *  absent is the launch's. */
  readonly input: Omit<RunInput, 'instruction'> & {
    readonly instruction?: string;
  };
  /** The structured output the run submitted: the settled value of its
   *  `submit_output` call, or of a script run's handed-down call. */
  readonly structured: { readonly value: JsonValue } | null;
  /** The turn whose final-tool nudge was appended, so it is asked once. */
  readonly finalToolTurn: number | null;
  /** The next response must call the final tool: its nudge was appended
   *  and no response has answered it. */
  readonly forceFinalTool: boolean;
  /** The latest response's answer was finalized for display. */
  readonly answerFinalized: boolean;
  /** The latest `tools.offered` row's set; `null` before the first. */
  readonly offeredTools: readonly OfferedTool[] | null;
  /** The plugin whose continuation the latest `tools.offered` row pinned. */
  readonly offeredContinuation: string | null;
  /** The names of the skills it listed. */
  readonly offeredSkills: readonly string[];
  /** The address of the system text the run's context froze. */
  readonly offeredSystem: string | null;
  /** The address of the context its model has been told; `null` before the
   *  first step and after a view edit, which each open it anew. */
  readonly offeredContext: string | null;
  readonly offeredHooks: readonly string[]; // the hooks it pinned
  /** The run's `context.blob` rows: model-facing content by address. */
  readonly contents: Readonly<Record<string, JsonValue>>;
  /** The `hook.outcome` rows by point: a recorded point never runs again. */
  readonly hookOutcomes: HookOutcomes;
};

/** Companions committed beside the run history fact; the loop ignores them. */
type CardRowType = 'tool.start' | 'tool.end' | 'stream.end' | SettlementType;
type SettlementType = 'run.report' | 'run.result' | 'child.turn';

/** The rows `foldRow` applies: the shared rows and the run history's own arms. */
type FoldedRowType =
  | SharedRunRow['type']
  | Exclude<RunHistoryDraft['type'], CardRowType>
  | 'run.activate'
  | 'response.finalized';

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
  'run.model': true,
  'run.detach': true,
  'run.end': true,
  'run.removed': true,
  'run.description': true,
  'conversation.progress': true,
  'run.fact': true,
  'child.park': true,
  'plugin.fact': true,
  'approval.policy': true,
  log: true,
  'stage.start': true,
  'stage.end': true,
  usage: true,
  'context.state': true,
  'stream.start': true,
  'run.report': true,
  'run.result': true,
  'followup.closed': true,
  // The child loop's own bookkeeping: folded by its readers, not the loop.
  'child.turn': true,
};
const IGNORED = new Set<string>(Object.keys(IGNORED_ROW_TYPES));

/** The state a run starts from: every field at its zero, no family bound
 *  yet. The run program opens from this and stamps its family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  ...freshRunPosition(),
  round: 0,
  commit,
  runHistoryRows: 0,
  phase: null,
  modelId: null,
  backend: null,
  lastError: null,
  declinedRoutes: [],
  messages: [],
  continuation: null,
  invocation: null,
  lastTurn: null,
  countStale: false,
  pendingResponse: null,
  decidedSinceActivation: new Set(),
  usage: EMPTY_RUN_USAGE_TOTALS,
  edited: [],
  toolCalls: 0,
  lastEdit: null,
  input: {},
  structured: null,
  finalToolTurn: null,
  forceFinalTool: false,
  answerFinalized: false,
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
 * they are not the one kind that outlives the process that asked. A tool
 * call's own request (a command, an edit, a plan, a delegation, a question)
 * is bound to the call it parks, and a resume re-enters it; what is left
 * unbound is a later request of an attempt already past its first, which
 * parks a body nothing can re-enter, so a resume retires those as cancelled
 * before it continues the run (`RunHistory.acquire`). An `externalInquiry` is
 * the exception by contract:
 * its tool returns at once and its answer arrives as a follow-up, whichever
 * process is running the run by then, so it stands unbound across every
 * batch its run writes.
 */
export function unboundRequests(state: RunState): readonly string[] {
  // The recovery bindings the rows carry (R5): the retry request the turn's
  // failed attempt asks and every pending call's `tool.binding`.
  const bindings = new Set<string | undefined>(
    Object.values(state.pendingResponse?.records ?? {}).map(
      ({ status }) => boundRequestOf(status)?.requestId,
    ),
  );
  const asked = state.invocation?.current.failed?.next;
  if (asked?.kind === 'ask') bindings.add(asked.requestId);
  return Object.entries(state.requests).flatMap(([requestId, request]) =>
    request.resolved ||
    bindings.has(requestId) ||
    !requestParksItsCaller(request.payload)
      ? []
      : [requestId],
  );
}

/**
 * The routes the run declines once `decided` lands: a retry answered with
 * the user's own API key declines the route its offer named, on this run's
 * history only, so no concurrent run or stored preference changes.
 */
function declinedBy(
  state: RunState,
  decided: Extract<RunHistoryRow, { type: 'request.decided' }>,
): RunState['declinedRoutes'] {
  const opened = state.requests[decided.requestId]?.payload;
  const offer = opened?.kind === 'retry' ? opened.data.credentialSwitch : null;
  const { decision } = decided;
  return decision.action === 'retry' &&
    decision.credentials === 'personal' &&
    offer?.kind === 'decline-route' &&
    !state.declinedRoutes.includes(offer.route)
    ? [...state.declinedRoutes, offer.route]
    : state.declinedRoutes;
}

type Fold = Result.Result<RunState, RunHistoryInconsistent>;

/** `input` with what a row recorded: each field it names replaces the
 *  last, and a `null` instruction returns to the launch's. */
function withInput(
  input: RunState['input'],
  recorded: RunInput | null | undefined,
): RunState['input'] {
  if (recorded == null) return input;
  const { instruction: was, ...kept } = input;
  const { instruction, system, activated, memoryMisses } = recorded;
  const next = instruction === undefined ? was : (instruction ?? undefined);
  return {
    ...kept,
    ...(system !== undefined && { system }),
    ...(activated !== undefined && { activated }),
    ...(memoryMisses !== undefined && { memoryMisses }),
    ...(next !== undefined && { instruction: next }),
  };
}

const refuse = (
  reason: RunHistoryInconsistent['reason'],
  detail: string,
  commit: CommitOrdinal | null,
): Result.Result<never, RunHistoryInconsistent> =>
  Result.fail(new RunHistoryInconsistent({ reason, detail, commit }));

/** Why a row of `attempt` cannot move a call standing at `status`, or null:
 *  a settled call is closed, and a call's attempt never goes back. */
const openFor = (
  callId: string,
  status: PendingCall['status'],
  attempt: number,
): string | null => {
  if (status.kind === 'settled')
    return `${callId} is already settled at attempt ${status.attempt}`;
  const reached = attemptOf(status);
  return attempt < reached
    ? `${callId} attempt ${attempt} is below ${reached}`
    : null;
};

const opened = (state: RunState | null): state is RunState =>
  state !== null && state.phase !== null;

function foldRow(
  current: RunState | null,
  row: RunHistoryRow,
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
  /** A row out of the order the run history writes. */
  const outOfOrder = (detail: string) => refuse('out-of-order', detail, commit);
  if (current !== null && commit <= current.commit) {
    return outOfOrder(`commit ${commit} is not above ${current.commit}`);
  }
  /** A row that presupposes the opening position, folded before it. */
  const beforeOpening = (what: string) =>
    outOfOrder(`${what} before the opening run.position`);
  /** The state with this run history row counted in. */
  const advance = (state: RunState): RunState => ({
    ...state,
    commit,
    runHistoryRows: state.runHistoryRows + 1,
  });
  /** `state` with this row counted and `call` as `pending`'s record of
   *  `callId`. */
  const withCall = (
    state: RunState,
    pending: PendingResponse,
    callId: string,
    call: PendingCall,
  ): RunState => {
    const records = writable(pass, pending.records, copyById);
    records[callId] = call;
    return { ...advance(state), pendingResponse: { ...pending, records } };
  };
  // Pending input is the publisher's: a queued row only opens an empty run.
  if (isFollowUpRow(row))
    return current === null && row.type === 'followup.queued'
      ? Result.succeed(freshRunState(commit))
      : null;
  if (isSharedRunRow(row)) {
    // The rows `sessionFold` reads too: applied once, in `runRows.ts`.
    // `unresolved` is a malformed aggregate here: this fold reads a run's
    // whole history, so a decision always follows the opening it answers.
    const verdict = applyRunRow(current, row, pass);
    if (verdict.kind === 'unchanged') return null;
    if (verdict.kind === 'unresolved') {
      return outOfOrder(`decision names no request ${verdict.requestId}`);
    }
    if (verdict.kind === 'contradiction') {
      return outOfOrder(verdict.detail);
    }
    const state = current ?? freshRunState(commit);
    const at = verdict.rows.at;
    return Result.succeed({
      ...state,
      ...(row.type === 'request.decided'
        ? {
            decidedSinceActivation: new Set([
              ...state.decidedSinceActivation,
              row.requestId,
            ]),
            declinedRoutes: declinedBy(state, row),
          }
        : {}),
      commit,
      // Only the loop's own position is a run history row; queued input, output
      // and the requests a session opens do not open a run.
      runHistoryRows: state.runHistoryRows + (at === undefined ? 0 : 1),
      ...verdict.rows,
      phase: phaseAfter(state.phase, at),
    });
  }
  switch (row.type) {
    case 'run.activate':
      // A new owner's lifecycle: whatever it decides from here, no earlier
      // process waited on.
      return current === null
        ? null
        : Result.succeed({
            ...current,
            commit,
            decidedSinceActivation: new Set(),
          });
    case 'run.config': {
      // What the run runs on: its model, and once it binds, its backend and
      // the routes its launch declined. Its registration writes one before
      // the run opens and a switch the next; a new model drops the old one's
      // continuation, and the next step renders the system text anew.
      const state = current ?? freshRunState(commit);
      const modelId = row.config.model ?? state.modelId;
      const binding = row.binding ?? null;
      const switched = state.modelId !== null && modelId !== state.modelId;
      return Result.succeed({
        ...state,
        commit,
        modelId,
        backend: binding?.backend ?? state.backend,
        declinedRoutes:
          binding === null
            ? state.declinedRoutes
            : [
                ...new Set([
                  ...state.declinedRoutes,
                  ...binding.declinedRoutes,
                ]),
              ],
        ...(switched
          ? { continuation: null, offeredSystem: null, offeredContext: null }
          : {}),
      });
    }
    case 'response.finalized':
      // The answer the loop finalized for display: its policy ran.
      return current === null
        ? null
        : Result.succeed({ ...current, commit, answerFinalized: true });
    case 'model.message': {
      const p = row.payload;
      // A summary's attempts record its billed calls; the loop continues
      // from none of them (its `context.edit` carries its usage).
      if (
        (p.kind === 'attempt' || p.kind === 'failed') &&
        p.purpose === 'summary'
      )
        return null;
      if (p.kind === 'append' && p.sourceResponse === null) {
        // Input: a new turn, which retires the last one's invocation and
        // its failure.
        const state = current ?? freshRunState(commit);
        return Result.succeed({
          ...advance(state),
          messages: appended(state, ...p.messages),
          input: withInput(state.input, p.input),
          ...(p.reason === 'final-tool'
            ? { finalToolTurn: state.turn, forceFinalTool: true }
            : {}),
          invocation: null,
          lastError: null,
        });
      }
      if (!opened(current)) return beforeOpening(`${row.type} ${p.kind}`);
      const state = advance(current);
      switch (p.kind) {
        case 'attempt':
        case 'identified':
        case 'accepted':
        case 'cancelled':
        case 'failed':
        case 'response': {
          const invocation = invocationAfter(state.invocation, p);
          if (typeof invocation === 'string') return outOfOrder(invocation);
          const moved = { ...state, invocation };
          if (p.kind === 'attempt')
            return Result.succeed({
              ...moved,
              phase: 'model.submitted',
              round: p.invocation.attempt === 1 ? state.round + 1 : state.round,
            });
          if (p.kind === 'failed') {
            if (
              p.next.kind === 'ask' &&
              state.requests[p.next.requestId] === undefined
            )
              return outOfOrder(`a failed attempt asks ${p.next.requestId}`);
            // A failure that ends the turn or asks; a lost chain is dropped.
            const { kind } = p.next;
            return Result.succeed({
              ...moved,
              lastError:
                kind === 'stop' || kind === 'ask' ? p.error : state.lastError,
              continuation: kind === 'unchain' ? null : state.continuation,
            });
          }
          if (p.kind !== 'response') return Result.succeed(moved);
          if (state.pendingResponse !== null) {
            return outOfOrder(
              `response ${p.responseId} while ${state.pendingResponse.responseId} is undelivered`,
            );
          }
          const settled: RunState = {
            ...moved,
            continuation:
              p.turn.kind === 'http' ? (p.turn.continuation ?? null) : null,
            lastError: null,
            lastTurn: p.turn,
            countStale: false,
            usage: addTurnUsage(state.usage, p.usage),
            forceFinalTool: false,
            answerFinalized: false,
          };
          if (p.calls.length === 0) {
            return Result.succeed({
              ...settled,
              messages: appended(settled, assistantMessageFromResult(p.turn)),
            });
          }
          return Result.succeed({
            ...settled,
            pendingResponse: pendingResponseOf(p),
          });
        }
        case 'handed-down':
          if (state.invocation !== null || state.pendingResponse !== null)
            return outOfOrder(`handed-down ${p.responseId} over an open call`);
          return Result.succeed({
            ...state,
            round: state.round + 1,
            pendingResponse: pendingResponseOf(p),
          });
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
            (call) => settlementOf(pending, call.callId) === null,
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
            messages: appended(state, pending.assistant, ...p.messages),
            pendingResponse: null,
          });
        }
      }
      // Exhaustive over `ModelMessagePayloadSchema`'s kinds: a new arm is a
      // compile error here, never a silently ignored row.
      return p satisfies never;
    }
    case 'context.edit': {
      const p = row.payload;
      // A fork's seed is its run's first view: it opens nothing, like an
      // undelivered append, and comes before the opening position. Every
      // other edit edits a view an opened run already holds.
      if ((p.cause === 'fork') === opened(current)) {
        return p.cause === 'fork'
          ? outOfOrder('a fork edit on a run that is already open')
          : beforeOpening(row.type);
      }
      if (!opened(current)) {
        const state = current ?? freshRunState(commit);
        if (p.base !== null || p.range.to !== 0 || state.messages.length > 0) {
          return outOfOrder('a fork edit replaces no earlier view');
        }
        return Result.succeed({
          ...advance(state),
          messages: appended(state, ...p.messages),
          input: withInput(state.input, p.input),
          lastEdit: row.seq,
        });
      }
      const base = current.lastEdit;
      if (p.base !== base) {
        return outOfOrder(
          `an edit computed at ${p.base ?? 'no edit'} lands after ${base ?? 'no edit'}`,
        );
      }
      if (p.range.to > current.messages.length) {
        return outOfOrder(
          `an edit of messages [${p.range.from}, ${p.range.to}) over ${current.messages.length}`,
        );
      }
      const messages = [
        ...current.messages.slice(0, p.range.from),
        ...p.messages,
        ...current.messages.slice(p.range.to),
      ];
      pass.add(messages);
      return Result.succeed({
        ...advance(current),
        messages,
        continuation: null,
        // The next step renders the system text anew, every change in it.
        offeredSystem: null,
        offeredContext: null,
        usage: addTurnUsage(current.usage, p.usage),
        countStale:
          current.countStale ||
          p.range.from !== p.range.to ||
          p.messages.length > 0,
        lastEdit: row.seq,
      });
    }
    case 'script.call': {
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      if (
        pending === null ||
        !pending.calls.some((call) => call.callId === p.scriptCallId)
      ) {
        return outOfOrder(
          `${p.callId} names no pending call ${p.scriptCallId}`,
        );
      }
      if (Object.hasOwn(pending.records, p.callId)) {
        return outOfOrder(`${p.callId} is already recorded`);
      }
      return Result.succeed(
        withCall(current, pending, p.callId, {
          script: p,
          status: { kind: 'issued' },
        }),
      );
    }
    case 'tool.intent': {
      // The call's body begins: from here it may have run. Once per
      // attempt, an attempt never goes back, and a call asking for this
      // attempt keeps its own request as the attempt's binding.
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      const call = pending?.records[p.callId];
      const issuer = p.origin.kind === 'script' ? p.origin.scriptCallId : null;
      if (
        pending === null ||
        call === undefined ||
        (p.origin.kind === 'response' &&
          pending.responseId !== p.origin.responseId) ||
        (call.script?.scriptCallId ?? null) !== issuer
      ) {
        return outOfOrder(`intent names ${p.callId}, no call of its origin`);
      }
      const { status } = call;
      const refusal =
        status.kind === 'started' && status.attempt === p.attempt
          ? `${p.callId} attempt ${p.attempt} already started`
          : openFor(p.callId, status, p.attempt);
      if (refusal !== null) return outOfOrder(refusal);
      return Result.succeed(
        withCall(current, pending, p.callId, {
          ...call,
          status: {
            kind: 'started',
            attempt: p.attempt,
            binding:
              status.kind === 'asking' && status.attempt === p.attempt
                ? { requestId: status.requestId, role: 'call' }
                : null,
          },
        }),
      );
    }
    case 'tool.binding': {
      // The request that guards one call attempt, committed with the
      // `request.opened` it names. The call's own request may come before
      // the attempt's body starts (its guard's approval) or after (the
      // first its body raised); the outcome question only after. A later
      // binding of the same attempt replaces it (a request retired as
      // cancelled, asked again under a new id).
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      const call = pending?.records[p.callId];
      if (pending === null || call === undefined) {
        return outOfOrder(`binding ${p.requestId} names no pending call`);
      }
      const { status } = call;
      const refusal = openFor(p.callId, status, p.attempt);
      if (refusal !== null) return outOfOrder(refusal);
      const running = status.kind === 'started' && status.attempt === p.attempt;
      if (p.role === 'outcome' && !running) {
        return outOfOrder(
          `outcome question ${p.requestId} for ${p.callId}, whose attempt ${p.attempt} never started`,
        );
      }
      return Result.succeed(
        withCall(current, pending, p.callId, {
          ...call,
          status: running
            ? {
                kind: 'started',
                attempt: p.attempt,
                binding: { requestId: p.requestId, role: p.role },
              }
            : { kind: 'asking', attempt: p.attempt, requestId: p.requestId },
        }),
      );
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
    case 'tool.result': {
      if (!opened(current)) return beforeOpening(row.type);
      const p = row.payload;
      const pending = current.pendingResponse;
      const call =
        pending?.responseId === p.responseId
          ? pending.records[p.callId]
          : undefined;
      if (pending === null || call === undefined) {
        return refuse(
          'orphan-settlement',
          `${p.callId} settles no pending call of ${p.responseId}`,
          commit,
        );
      }
      // Only the attempt the rows reached, or a later one that settled
      // before its body started, closes the call; and only once.
      const refusal = openFor(p.callId, call.status, p.attempt);
      if (refusal !== null) {
        return call.status.kind === 'settled'
          ? refuse('orphan-settlement', refusal, commit)
          : outOfOrder(refusal);
      }
      const settled = withCall(current, pending, p.callId, {
        ...call,
        status: {
          kind: 'settled',
          at: commit,
          attempt: p.attempt,
          disposition: p.disposition,
          duplicateOf: p.duplicateOf,
          result: p.result,
          attachments: p.attachments,
        },
      });
      const ran = p.disposition === 'executed' || p.disposition === 'failed';
      // The run's structured output: its `submit_output` call's value, or
      // a script run's handed-down call's (no model produced that response:
      // its message has no origin).
      const own = pending.calls.find(({ callId }) => callId === p.callId);
      const submitted =
        p.result.status === 'executed' &&
        p.result.value !== undefined &&
        (own?.toolName === STRUCTURED_OUTPUT_TOOL_NAME ||
          (own !== undefined && pending.assistant.origin === null))
          ? { value: p.result.value }
          : null;
      const edits = p.result.status === 'executed' ? p.result.edits : [];
      const fresh = [
        ...new Set((edits ?? []).map(({ path }) => path).filter(Boolean)),
      ].filter((path) => !settled.edited.includes(path));
      return Result.succeed({
        ...settled,
        edited:
          fresh.length === 0 ? settled.edited : [...settled.edited, ...fresh],
        toolCalls: settled.toolCalls + (ran ? 1 : 0),
        structured: submitted ?? settled.structured,
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
 * what the run history test pins. `null` out means no run history row has folded.
 *
 * Returns a typed inconsistency rather than throwing or defaulting: a row
 * the fold cannot apply is corruption, not a state to degrade into.
 */
export function foldRunState(
  state: RunState | null,
  rows: readonly RunHistoryRow[],
): Result.Result<RunState | null, RunHistoryInconsistent> {
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
