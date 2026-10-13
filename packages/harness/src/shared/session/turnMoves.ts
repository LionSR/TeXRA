/**
 * The moves of a turn in flight: the lines of the run's row grammar
 * (`GRAMMAR` in `runStateFold.ts`) that move the turn's model invocation and
 * its pending response, whose records `inFlight.ts` defines.
 *
 * Lifecycle: a turn's invocation opens at its first `attempt` row and moves
 * through `identified`, `accepted`, `failed` or `cancelled` to its
 * `response`; a response with calls (or a script run's `handed-down` call)
 * opens the pending response, each call of which a `script.call` issues, a
 * `tool.intent` starts and a `tool.result` settles; the `append` that
 * delivers it, which every call settled first, closes the turn. Single
 * writer: `RunCell.append` commits every row these lines read, and
 * `foldRunState` alone applies them.
 */
import { Result } from 'effect';

import { assistantMessageFromResult } from '@texra-ai/llm';
import { addTurnUsage } from '@shared/schemas';
import { copyById, writable, type FoldPass } from './runRows';
import {
  attemptOf,
  callSettlementOf,
  invocationAfter,
  pendingResponseOf,
  type PendingCall,
  type PendingResponse,
} from './inFlight';
import type { HistoryMessage, ModelMessagePayload } from './historyTurns';
import type { Move, Refusal, RunState, Transition } from './runStateFold';

/** A row out of the order the run history writes. */
export const outOfOrder = (detail: string): Result.Result<never, Refusal> =>
  Result.fail({ reason: 'out-of-order', detail });

/** `messages` with `added` appended: the pass's own array, written once
 *  copied, so a batch of rows appends without re-copying the history. */
export const appended = (
  pass: FoldPass,
  state: RunState,
  ...added: readonly HistoryMessage[]
): HistoryMessage[] => {
  const messages = writable(pass, state.messages, (m) => [...m]);
  for (const message of added) messages.push(message);
  return messages;
};

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

/** `state` with `call` as `pending`'s record of `callId`. */
const withCall = (
  pass: FoldPass,
  state: RunState,
  pending: PendingResponse,
  callId: string,
  call: PendingCall,
): RunState => {
  const records = writable(pass, pending.records, copyById);
  records[callId] = call;
  return { ...state, pendingResponse: { ...pending, records } };
};

/** Why the delivery's tool group does not answer every call of `pending`,
 *  in call order, with the status its committed settlement holds, or null. */
const unreportedCall = (
  pending: PendingResponse,
  group: HistoryMessage | undefined,
): string | null => {
  const results = group?.role === 'tool' ? group.results : [];
  if (results.length !== pending.calls.length)
    return `${results.length} results for ${pending.calls.length} calls`;
  for (const [ordinal, { callId }] of pending.calls.entries()) {
    const settled = callSettlementOf(pending, callId)?.result.status;
    const reported = results[ordinal];
    const expected = settled === 'executed' ? 'success' : 'error';
    if (
      settled === undefined ||
      reported?.callOrdinal !== ordinal ||
      reported.status !== expected
    )
      return `ordinal ${ordinal} does not report ${callId}'s settlement`;
  }
  return null;
};

type MessageKind = ModelMessagePayload['kind'];
type Message<K extends MessageKind> = Extract<ModelMessagePayload, { kind: K }>;
type InvocationKind = Exclude<MessageKind, 'handed-down' | 'append'>;

/** `state` with the turn's invocation moved by `p` (`invocationAfter`). */
const invoked = (state: RunState, p: Message<InvocationKind>): Move => {
  const invocation = invocationAfter(state.invocation, p);
  return typeof invocation === 'string'
    ? outOfOrder(invocation)
    : Result.succeed({ ...state, invocation });
};

/**
 * The `model.message` grammar, by payload kind: the turn's invocation
 * (`attempt` through `response`), a script run's `handed-down` call, and an
 * `append` that is a new turn's input or the delivery of the pending
 * response, which every call of it settled first.
 */
const MESSAGE_MOVES: {
  readonly [K in MessageKind]: (
    state: RunState,
    p: Message<K>,
    pass: FoldPass,
  ) => Move;
} = {
  attempt: (state, p) =>
    Result.map(invoked(state, p), (moved) => ({
      ...moved,
      phase: 'model.submitted',
      round: p.invocation.attempt === 1 ? state.round + 1 : state.round,
    })),
  identified: invoked,
  accepted: invoked,
  cancelled: invoked,
  failed: (state, p) =>
    Result.flatMap(invoked(state, p), (moved) => {
      const { next } = p;
      if (next.kind === 'ask' && state.requests[next.requestId] === undefined)
        return outOfOrder(`a failed attempt asks ${next.requestId}`);
      // A failure that ends the turn or asks; a lost chain is dropped.
      const asked = next.kind === 'stop' || next.kind === 'ask';
      return Result.succeed({
        ...moved,
        lastError: asked ? p.error : state.lastError,
        continuation: next.kind === 'unchain' ? null : state.continuation,
      });
    }),
  response: (state, p, pass) =>
    Result.flatMap(invoked(state, p), (moved) => {
      if (state.pendingResponse !== null)
        return outOfOrder(
          `response ${p.responseId} while ${state.pendingResponse.responseId} is undelivered`,
        );
      const settled: RunState = {
        ...moved,
        continuation:
          p.turn.kind === 'http' ? (p.turn.continuation ?? null) : null,
        lastError: null,
        lastTurn: p.turn,
        countStale: false,
        usage: addTurnUsage(state.usage, p.usage),
      };
      return Result.succeed(
        p.calls.length === 0
          ? {
              ...settled,
              messages: appended(
                pass,
                settled,
                assistantMessageFromResult(p.turn),
              ),
            }
          : { ...settled, pendingResponse: pendingResponseOf(p) },
      );
    }),
  'handed-down': (state, p) =>
    state.invocation !== null || state.pendingResponse !== null
      ? outOfOrder(`handed-down ${p.responseId} over an open call`)
      : Result.succeed({
          ...state,
          round: state.round + 1,
          pendingResponse: pendingResponseOf(p),
        }),
  append: (state, p, pass) => {
    // Input: a new turn, which retires the last one's invocation and its
    // failure.
    if (p.sourceResponse === null)
      return Result.succeed({
        ...state,
        messages: appended(pass, state, ...p.messages),
        invocation: null,
        lastError: null,
      });
    const pending = state.pendingResponse;
    const mismatch = (detail: string) =>
      Result.fail<Refusal>({ reason: 'mismatched-delivery', detail });
    if (pending === null || pending.responseId !== p.sourceResponse)
      return mismatch(
        `append delivers ${p.sourceResponse}, pending is ${pending?.responseId ?? 'none'}`,
      );
    const unreported = unreportedCall(pending, p.messages[0]);
    if (unreported !== null) return mismatch(unreported);
    return Result.succeed({
      ...state,
      messages: appended(pass, state, pending.assistant, ...p.messages),
      pendingResponse: null,
    });
  },
};

/** `p` moved through its kind's line of {@link MESSAGE_MOVES}. */
const moveMessage = <K extends MessageKind>(
  kind: K,
  state: RunState,
  p: Message<K>,
  pass: FoldPass,
): Move => MESSAGE_MOVES[kind](state, p, pass);

/** The grammar's lines for the turn's rows: every one moves an opened run. */
export const TURN_GRAMMAR: {
  readonly [
    K in 'model.message' | 'script.call' | 'tool.intent' | 'tool.result'
  ]: Transition<K>;
} = {
  'model.message': {
    // A summary's attempts record its billed calls; the loop continues
    // from none of them (its `context.edit` carries its usage). A new
    // turn's input opens nothing.
    admits: ({ payload: p }) => {
      if (
        (p.kind === 'attempt' || p.kind === 'failed') &&
        p.purpose === 'summary'
      )
        return 'skip';
      return p.kind === 'append' && p.sourceResponse === null
        ? 'any'
        : 'opened';
    },
    apply: (state, row, pass) =>
      moveMessage(row.payload.kind, state, row.payload, pass),
  },
  'script.call': {
    admits: 'opened',
    apply: (state, row, pass) => {
      const p = row.payload;
      const pending = state.pendingResponse;
      if (!pending?.calls.some((call) => call.callId === p.scriptCallId))
        return outOfOrder(
          `${p.callId} names no pending call ${p.scriptCallId}`,
        );
      if (Object.hasOwn(pending.records, p.callId))
        return outOfOrder(`${p.callId} is already recorded`);
      return Result.succeed(
        withCall(pass, state, pending, p.callId, {
          script: p,
          status: { kind: 'issued' },
        }),
      );
    },
  },
  'tool.intent': {
    // The call's body begins: from here it may have run. Once per
    // attempt, and an attempt never goes back.
    admits: 'opened',
    apply: (state, row, pass) => {
      const p = row.payload;
      const pending = state.pendingResponse;
      const call = pending?.records[p.callId];
      const issuer = p.origin.kind === 'script' ? p.origin.scriptCallId : null;
      if (
        pending === null ||
        call === undefined ||
        (p.origin.kind === 'response' &&
          pending.responseId !== p.origin.responseId) ||
        (call.script?.scriptCallId ?? null) !== issuer
      )
        return outOfOrder(`intent names ${p.callId}, no call of its origin`);
      const { status } = call;
      const refusal =
        status.kind === 'started' && status.attempt === p.attempt
          ? `${p.callId} attempt ${p.attempt} already started`
          : openFor(p.callId, status, p.attempt);
      if (refusal !== null) return outOfOrder(refusal);
      return Result.succeed(
        withCall(pass, state, pending, p.callId, {
          ...call,
          status: { kind: 'started', attempt: p.attempt },
        }),
      );
    },
  },
  'tool.result': {
    admits: 'opened',
    apply: (state, row, pass) => {
      const p = row.payload;
      const pending = state.pendingResponse;
      const call =
        pending?.responseId === p.responseId
          ? pending.records[p.callId]
          : undefined;
      if (pending === null || call === undefined)
        return Result.fail({
          reason: 'orphan-settlement',
          detail: `${p.callId} settles no pending call of ${p.responseId}`,
        });
      // Only the attempt the rows reached, or a later one that settled
      // before its body started, closes the call; and only once.
      const refusal = openFor(p.callId, call.status, p.attempt);
      if (refusal !== null)
        return call.status.kind === 'settled'
          ? Result.fail({ reason: 'orphan-settlement', detail: refusal })
          : outOfOrder(refusal);
      return Result.succeed(
        withCall(pass, state, pending, p.callId, {
          ...call,
          status: {
            kind: 'settled',
            at: row.commit,
            attempt: p.attempt,
            disposition: p.disposition,
            duplicateOf: p.duplicateOf,
            result: p.result,
            attachments: p.attachments,
          },
        }),
      );
    },
  },
};
