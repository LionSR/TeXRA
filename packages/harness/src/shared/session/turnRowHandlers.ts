/**
 * The row handlers for a turn in flight: the entries of `ROW_HANDLERS`
 * (`runState.ts`) that update the turn's model invocation and its
 * pending response, whose records `inFlight.ts` defines.
 *
 * Lifecycle: a turn's invocation opens at its first `attempt` row and goes
 * through `identified`, `accepted`, `failed` or `cancelled` to its
 * `response`; a response with calls (or a script run's `handed-down` call)
 * opens the pending response, each call of which a `script.call` issues, a
 * `tool.intent` starts and a `tool.result` finishes; the `append` that
 * delivers the results, once every call has one, closes the turn. Single
 * writer: `RunCell.append` commits every row these handlers read, and
 * `applyRunRows` alone applies them.
 */
import { Result } from 'effect';

import { assistantMessageFromResult } from '@texra-ai/llm';
import { addTurnUsage } from '@shared/schemas';
import { byId, copyById, ownCopy, type BatchCopies } from './runRows';
import { resultFacts, withInput } from './runFacts';
import {
  attemptOf,
  callSettlementOf,
  invocationAfter,
  type PendingCall,
  type PendingResponse,
} from './inFlight';
import type { HistoryMessage, ModelMessagePayload } from './historyTurns';
import type {
  RowHandler,
  RowOutcome,
  RowRejection,
  RunState,
} from './runState';

/** The pending response row `p` opens, with every call issued. */
function pendingResponseOf(
  p: Extract<ModelMessagePayload, { kind: 'response' | 'handed-down' }>,
): PendingResponse {
  const calls = p.kind === 'response' ? p.calls : [p.call];
  const opened = {
    responseId: p.responseId,
    calls,
    records: byId(
      calls.map((call): [string, PendingCall] => [
        call.callId,
        { script: null, status: { kind: 'issued' } },
      ]),
    ),
  };
  if (p.kind === 'response')
    return { ...opened, assistant: assistantMessageFromResult(p.turn) };
  const { call, argumentsText } = p;
  return {
    ...opened,
    assistant: {
      role: 'assistant',
      origin: null,
      content: [
        {
          kind: 'local-call',
          providerCallId: call.callId,
          name: call.toolName,
          argumentsText,
        },
      ],
    },
  };
}

/** A row out of the order the run history writes. */
export const outOfOrder = (
  detail: string,
): Result.Result<never, RowRejection> =>
  Result.fail({ reason: 'out-of-order', detail });

/** `messages` with `added` appended: the batch's own array, changed in place
 *  once copied, so a batch of rows appends without re-copying the history. */
const appended = (
  copies: BatchCopies,
  state: RunState,
  ...added: readonly HistoryMessage[]
): HistoryMessage[] => {
  const messages = ownCopy(copies, state.messages, (m) => [...m]);
  for (const message of added) messages.push(message);
  return messages;
};

/** Why a row of `attempt` cannot update a call standing at `status`, or
 *  null: a finished call is closed, and a call's attempt never goes back. */
const closedTo = (
  callId: string,
  status: PendingCall['status'],
  attempt: number,
): string | null => {
  if (status.kind === 'settled')
    return `${callId} already has a result at attempt ${status.attempt}`;
  const reached = attemptOf(status);
  return attempt < reached
    ? `${callId} attempt ${attempt} is below ${reached}`
    : null;
};

/** `state` with `call` as `pending`'s record of `callId`. */
const withCall = (
  copies: BatchCopies,
  state: RunState,
  pending: PendingResponse,
  callId: string,
  call: PendingCall,
): RunState => {
  const records = ownCopy(copies, pending.records, copyById);
  records[callId] = call;
  return { ...state, pendingResponse: { ...pending, records } };
};

/** Why the delivery's tool group does not answer every call of `pending`,
 *  in call order, with the status its committed result holds, or null. */
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
      return `ordinal ${ordinal} does not report ${callId}'s result`;
  }
  return null;
};

type MessageKind = ModelMessagePayload['kind'];
type Message<K extends MessageKind> = Extract<ModelMessagePayload, { kind: K }>;
type InvocationKind = Exclude<MessageKind, 'handed-down' | 'append'>;

/** `state` with the turn's invocation updated by `p` (`invocationAfter`). */
const withInvocation = (
  state: RunState,
  p: Message<InvocationKind>,
): RowOutcome => {
  const invocation = invocationAfter(state.invocation, p);
  return typeof invocation === 'string'
    ? outOfOrder(invocation)
    : Result.succeed({ ...state, invocation });
};

/**
 * The `model.message` handlers, by payload kind: the turn's invocation
 * (`attempt` through `response`), a script run's `handed-down` call, and an
 * `append` that is a new turn's input or the delivery of the pending
 * response, which every call of it must have a result for first.
 */
const MESSAGE_HANDLERS: {
  readonly [K in MessageKind]: (
    state: RunState,
    p: Message<K>,
    copies: BatchCopies,
  ) => RowOutcome;
} = {
  attempt: (state, p) =>
    Result.map(withInvocation(state, p), (updated) => ({
      ...updated,
      phase: 'model.submitted',
    })),
  identified: withInvocation,
  accepted: withInvocation,
  cancelled: withInvocation,
  failed: (state, p) =>
    Result.flatMap(withInvocation(state, p), (updated) => {
      const { next } = p;
      if (next.kind === 'ask' && state.requests[next.requestId] === undefined)
        return outOfOrder(`a failed attempt asks ${next.requestId}`);
      // A failure that ends the turn or asks; a lost chain is dropped.
      const asked = next.kind === 'stop' || next.kind === 'ask';
      return Result.succeed({
        ...updated,
        lastError: asked ? p.error : state.lastError,
        continuation: next.kind === 'unchain' ? null : state.continuation,
      });
    }),
  response: (state, p, copies) =>
    Result.flatMap(withInvocation(state, p), (updated) => {
      if (state.pendingResponse !== null)
        return outOfOrder(
          `response ${p.responseId} while ${state.pendingResponse.responseId} is undelivered`,
        );
      const answered: RunState = {
        ...updated,
        continuation: p.turn.continuation ?? null,
        lastError: null,
        lastTurn: p.turn,
        countStale: false,
        usage: addTurnUsage(state.usage, p.usage),
        forceFinalTool: false,
        answerFinalized: false,
      };
      return Result.succeed(
        p.calls.length === 0
          ? {
              ...answered,
              messages: appended(
                copies,
                answered,
                assistantMessageFromResult(p.turn),
              ),
            }
          : { ...answered, pendingResponse: pendingResponseOf(p) },
      );
    }),
  'handed-down': (state, p) =>
    state.invocation !== null || state.pendingResponse !== null
      ? outOfOrder(`handed-down ${p.responseId} over an open call`)
      : Result.succeed({
          ...state,
          pendingResponse: pendingResponseOf(p),
        }),
  append: (state, p, copies) => {
    // Input: a new turn, which clears the last one's invocation and its
    // failure, and records what the input changed.
    if (p.sourceResponse === null)
      return Result.succeed({
        ...state,
        messages: appended(copies, state, ...p.messages),
        invocation: null,
        lastError: null,
        input: withInput(state.input, p.input),
        ...(p.reason === 'final-tool' && {
          finalToolTurn: state.turn,
          forceFinalTool: true,
        }),
      });
    const pending = state.pendingResponse;
    const mismatch = (detail: string) =>
      Result.fail<RowRejection>({ reason: 'mismatched-delivery', detail });
    if (pending === null || pending.responseId !== p.sourceResponse)
      return mismatch(
        `append delivers ${p.sourceResponse}, pending is ${pending?.responseId ?? 'none'}`,
      );
    const unreported = unreportedCall(pending, p.messages[0]);
    if (unreported !== null) return mismatch(unreported);
    return Result.succeed({
      ...state,
      messages: appended(copies, state, pending.assistant, ...p.messages),
      pendingResponse: null,
    });
  },
};

/** `p` applied by its kind's entry of {@link MESSAGE_HANDLERS}. */
const applyMessage = <K extends MessageKind>(
  kind: K,
  state: RunState,
  p: Message<K>,
  copies: BatchCopies,
): RowOutcome => MESSAGE_HANDLERS[kind](state, p, copies);

/** The handlers for the turn's rows: each needs an opened run, except a
 *  new turn's input and a summary's attempts. */
export const TURN_ROW_HANDLERS: {
  readonly [
    K in 'model.message' | 'script.call' | 'tool.intent' | 'tool.result'
  ]: RowHandler<K>;
} = {
  'model.message': {
    // A summary's attempts record its billed calls; the loop continues
    // from none of them (its `context.edit` carries its usage), so they
    // are ignored wherever they land. A new turn's input opens nothing.
    requires: ({ payload: p }) =>
      isSummaryAttempt(p) || (p.kind === 'append' && p.sourceResponse === null)
        ? 'any'
        : 'opened',
    apply: (state, { payload: p }, copies) =>
      isSummaryAttempt(p) ? null : applyMessage(p.kind, state, p, copies),
  },
  'script.call': {
    requires: 'opened',
    apply: (state, row, copies) => {
      const p = row.payload;
      const pending = state.pendingResponse;
      if (!pending?.calls.some((call) => call.callId === p.scriptCallId))
        return outOfOrder(
          `${p.callId} names no pending call ${p.scriptCallId}`,
        );
      if (Object.hasOwn(pending.records, p.callId))
        return outOfOrder(`${p.callId} is already recorded`);
      return Result.succeed(
        withCall(copies, state, pending, p.callId, {
          script: p,
          status: { kind: 'issued' },
        }),
      );
    },
  },
  'tool.intent': {
    // The call's body begins: from here it may have run. Once per
    // attempt, and an attempt never goes back.
    requires: 'opened',
    apply: (state, row, copies) => {
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
      const rejection =
        status.kind === 'started' && status.attempt === p.attempt
          ? `${p.callId} attempt ${p.attempt} already started`
          : closedTo(p.callId, status, p.attempt);
      if (rejection !== null) return outOfOrder(rejection);
      return Result.succeed(
        withCall(copies, state, pending, p.callId, {
          ...call,
          status: { kind: 'started', attempt: p.attempt },
        }),
      );
    },
  },
  'tool.result': {
    requires: 'opened',
    apply: (state, row, copies) => {
      const p = row.payload;
      const pending = state.pendingResponse;
      const call =
        pending?.responseId === p.responseId
          ? pending.records[p.callId]
          : undefined;
      if (pending === null || call === undefined)
        return Result.fail({
          reason: 'orphan-settlement',
          detail: `${p.callId} is no pending call of ${p.responseId}`,
        });
      // Only the attempt the rows reached, or a later one that finished
      // before its body started, closes the call; and only once.
      const rejection = closedTo(p.callId, call.status, p.attempt);
      if (rejection !== null)
        return call.status.kind === 'settled'
          ? Result.fail({ reason: 'orphan-settlement', detail: rejection })
          : outOfOrder(rejection);
      return Result.succeed({
        ...withCall(copies, state, pending, p.callId, {
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
        ...resultFacts(state, p, pending),
      });
    },
  },
};

/** Whether `p` is one of a summary's attempts, which the loop ignores. */
function isSummaryAttempt(p: ModelMessagePayload): boolean {
  return (
    (p.kind === 'attempt' || p.kind === 'failed') && p.purpose === 'summary'
  );
}
