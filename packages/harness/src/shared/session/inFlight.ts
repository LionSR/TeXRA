/**
 * What a run has in flight between asking and delivering. First the model
 * invocation: its attempts as their rows left them, and the one function
 * that reads its next move off them (`nextAttempt`), so the invoker's retry
 * loop holds no state of its own and a resume continues exactly where the
 * rows stand. Then the response it stands on until its calls settle: a
 * model's `response`, or the `handed-down` call a script's run opens on,
 * which no model made, so its assistant message has a null origin.
 */
import {
  assistantMessageFromResult,
  type ModelOrigin,
  type RemoteOperation,
} from '@texra-ai/llm';
import type {
  CommitOrdinal,
  DispatchFacts,
  FailedNext,
  InvocationRef,
  RequestDecision,
  RetryErrorInfo,
  ScriptCallPayload,
  ToolResultPayload,
} from '@shared/schemas';
import { byId, type RunPosition } from './runRows';
import type { HistoryMessage, ModelMessagePayload } from './historyTurns';

/** How an attempt ended, as its `failed` row records it. */
export type Failure = {
  readonly error: RetryErrorInfo;
  readonly next: FailedNext;
};

/** One attempt, as its rows left it. */
export type Attempt = {
  readonly ref: InvocationRef;
  /** What its `attempt` row recorded before the request was billed: the
   *  recorded request's address and the binding's origin. Null for an
   *  attempt that failed before it was sent, which no provider billed. */
  readonly sent: {
    readonly request: string;
    readonly origin: ModelOrigin;
  } | null;
  readonly providerResponseId: string | null;
  /** The background operation a resume observes; `cancelled` retires it. */
  readonly accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  } | null;
  /** Its `failed` row, or null while its outcome is unknown. */
  readonly failed: Failure | null;
};

/**
 * A model invocation: the attempt its rows last opened and how each earlier
 * one ended (`null`: it never recorded an outcome, a crash or a refreshed
 * credential sent the next one). It closes with its response, or, once it
 * stopped, with the input of the next turn.
 */
export type Invocation = {
  readonly current: Attempt;
  readonly earlier: readonly (Failure | null)[];
};

type InvocationRow = Extract<
  ModelMessagePayload,
  {
    kind:
      | 'attempt'
      | 'identified'
      | 'accepted'
      | 'cancelled'
      | 'failed'
      | 'response';
  }
>;

const sameRef = (a: InvocationRef, b: InvocationRef): boolean =>
  a.invocationId === b.invocationId && a.attempt === b.attempt;

/**
 * How each attempt of `invocation` before `ref` ended: its earlier ones,
 * and its current one unless `ref` is that one.
 */
export function failuresBefore(
  invocation: Invocation | null,
  ref: InvocationRef,
): readonly (Failure | null)[] {
  if (invocation === null) return [];
  return sameRef(invocation.current.ref, ref)
    ? invocation.earlier
    : [...invocation.earlier, invocation.current.failed];
}

/** The invocation after its row `p` (null: its response closed it), or why
 *  `p` cannot follow it. An `attempt` row opens the next attempt; so does a
 *  `failed` row naming it, for an attempt that failed before it was sent. */
export function invocationAfter(
  invocation: Invocation | null,
  p: InvocationRow,
): Invocation | null | string {
  const current = invocation?.current;
  return p.kind === 'attempt' ||
    (p.kind === 'failed' &&
      (current === undefined || !sameRef(current.ref, p.invocation)))
    ? openedBy(invocation, p)
    : movedBy(invocation, p);
}

/** The invocation `p` opens its next attempt in. */
function openedBy(
  invocation: Invocation | null,
  p: Extract<InvocationRow, { kind: 'attempt' | 'failed' }>,
): Invocation | string {
  const { invocationId, attempt } = p.invocation;
  const prior = invocation?.current.ref;
  const follows =
    attempt === 1
      ? invocation === null
      : prior?.invocationId === invocationId && attempt === prior.attempt + 1;
  if (!follows)
    return `${p.kind} ${attempt} of ${invocationId} does not follow ${prior?.attempt ?? 'no attempt'}`;
  return {
    current: {
      ref: p.invocation,
      sent:
        p.kind === 'attempt' ? { request: p.request, origin: p.origin } : null,
      providerResponseId: null,
      accepted: null,
      failed: p.kind === 'failed' ? { error: p.error, next: p.next } : null,
    },
    earlier: failuresBefore(invocation, p.invocation),
  };
}

/** The invocation after `p` moves or closes its open attempt. */
function movedBy(
  invocation: Invocation | null,
  p: InvocationRow,
): Invocation | null | string {
  const current = invocation?.current;
  if (
    invocation == null ||
    current === undefined ||
    current.failed !== null ||
    !sameRef(current.ref, p.invocation)
  )
    return `${p.kind} names no open attempt`;
  const moved = (patch: Partial<Attempt>): Invocation => ({
    ...invocation,
    current: { ...current, ...patch },
  });
  switch (p.kind) {
    case 'attempt':
      return 'an attempt row moves no attempt';
    case 'identified':
      return moved({ providerResponseId: p.providerResponseId });
    case 'accepted':
      return moved({
        accepted: { operation: p.operation, deadlineAtMs: p.deadlineAtMs },
      });
    case 'cancelled':
      return current.accepted === null
        ? 'cancelled names no accepted operation'
        : moved({ accepted: null });
    case 'failed':
      return moved({ failed: { error: p.error, next: p.next } });
    case 'response':
      return null;
  }
}

/** The credentials a person's retry answer picked. */
export type RetryCredentials = NonNullable<
  Extract<RequestDecision, { action: 'retry' }>['credentials']
>;

/**
 * An invocation's next move: `send` a new attempt (`retry`: after a
 * person's answer, which rebinds first), `observe` the accepted background
 * operation, ask again (`reask`) for an attempt a person admitted whose
 * outcome no row recorded, `await` the answer to the open retry request, or
 * end it (`fail`, `cancel`).
 */
export type Move =
  | { readonly kind: 'send'; readonly retry: RetryCredentials | null }
  | {
      readonly kind: 'observe';
      readonly attempt: Attempt & {
        readonly accepted: NonNullable<Attempt['accepted']>;
      };
    }
  | { readonly kind: 'reask'; readonly attempt: Attempt }
  | { readonly kind: 'await'; readonly requestId: string }
  | { readonly kind: 'fail'; readonly error: RetryErrorInfo }
  | { readonly kind: 'cancel' };

const SEND: Move = { kind: 'send', retry: null };

/**
 * The next move of `invocation` (null: a new one), from its rows and the
 * run's `requests` alone. An attempt with no recorded outcome is the one a
 * process never saw end: resent unasked, as any automatic attempt is, except
 * one a person admitted, which is asked again rather than resent, and an
 * accepted background operation, which is observed, never resubmitted.
 */
export function nextAttempt(
  invocation: Invocation | null,
  requests: RunPosition['requests'],
): Move {
  if (invocation === null) return SEND;
  const { current, earlier } = invocation;
  const { failed, accepted } = current;
  if (failed === null) {
    if (accepted !== null)
      return { kind: 'observe', attempt: { ...current, accepted } };
    // A person admitted an attempt of this invocation: whatever ran since
    // was billed on their word, so they are asked before it is sent again.
    return earlier.some((failure) => failure?.next.kind === 'ask')
      ? { kind: 'reask', attempt: current }
      : SEND;
  }
  switch (failed.next.kind) {
    case 'retry':
    case 'unchain':
      return SEND;
    case 'stop':
      return { kind: 'fail', error: failed.error };
    case 'cancel':
      return { kind: 'cancel' };
    case 'ask': {
      const { requestId } = failed.next;
      const decision = requests[requestId]?.decision ?? null;
      if (decision === null) return { kind: 'await', requestId };
      if (decision.action === 'retry')
        return { kind: 'send', retry: decision.credentials ?? 'configured' };
      return decision.action === 'deny'
        ? { kind: 'fail', error: failed.error }
        : { kind: 'cancel' };
    }
  }
}

/** What one failure says about the move after it. */
export interface FailureFacts {
  /** The vendor no longer holds the response this attempt chained on;
   *  true only for an attempt that sent a continuation. */
  readonly unchain: boolean;
  /** The same request may succeed when sent again. */
  readonly automatic: boolean;
  /** A person may be offered a retry. */
  readonly offered: boolean;
}

/**
 * What follows a failed attempt, recorded on its `failed` row, given how the
 * attempts before it ended (`failuresBefore`). `retries` automatic resends
 * per invocation, counted from its rows, so a resume keeps the budget a
 * crash interrupted; a lost chain is resent once outside it; past it, the
 * person is asked under `requestId`, or, where nobody can be asked (null),
 * it stops.
 */
export function failedNext(
  before: readonly (Failure | null)[],
  facts: FailureFacts,
  retries: number,
  requestId: string | null,
): FailedNext {
  // Once per invocation: the resend after it carries no continuation.
  if (
    facts.unchain &&
    !before.some((failure) => failure?.next.kind === 'unchain')
  )
    return { kind: 'unchain' };
  const spent = before.filter(
    (failure) => failure !== null && failure.next.kind !== 'unchain',
  ).length;
  if (facts.automatic && spent < retries) return { kind: 'retry' };
  return facts.offered && requestId !== null
    ? { kind: 'ask', requestId }
    : { kind: 'stop' };
}

type Settlement = Pick<
  ToolResultPayload,
  'attempt' | 'disposition' | 'duplicateOf' | 'result' | 'attachments'
>;

/** How far one call got, as its rows say: `issued`, no body started;
 *  `started`, the `tool.intent` of `attempt` committed, so the body may
 *  have run; `settled`, its `tool.result` at `at` ({@link attemptRequests}). */
export type CallStatus =
  | { readonly kind: 'issued' }
  | { readonly kind: 'started'; readonly attempt: number }
  | ({ readonly kind: 'settled'; readonly at: CommitOrdinal } & Settlement);

/** One call of the pending response, the same record whichever issued it:
 *  the response (`script` null) or one of its `script` calls' guests, whose
 *  `script.call` row it carries. */
export type PendingCall = {
  readonly script: ScriptCallPayload | null;
  readonly status: CallStatus;
};

/** The attempt a call's rows started: 0 before any started. */
export const attemptOf = (status: CallStatus): number =>
  status.kind === 'issued' ? 0 : status.attempt;

/** A call's attempt; 0 holds what its attempts share (a script's `agent` ask). */
type CallAttempt = Pick<ToolResultPayload, 'responseId' | 'callId' | 'attempt'>;

/** The id of the `ordinal`-th request (from 1) `at` raises: derived, never
 *  drawn, so a resumed attempt joins the request it left standing. */
export const callRequestId = (at: CallAttempt, ordinal: number): string =>
  `${at.responseId}/${at.callId}:${at.attempt}:${ordinal}`;

/** What one attempt asked: `raised` requests (ordinals 1..raised); `own`,
 *  the first no cancellation retired (a stop's decides nothing, so it asked
 *  again), since a later one parked a body already past its own answer. */
export interface AttemptRequests {
  readonly raised: number;
  readonly own: {
    readonly requestId: string;
    readonly request: RunPosition['requests'][string];
  } | null;
}

/** What `at` has asked, read off the run's `requests` by derived id. */
export function attemptRequests(
  requests: RunPosition['requests'],
  at: CallAttempt,
): AttemptRequests {
  let own: AttemptRequests['own'] = null;
  for (let raised = 0; ; raised += 1) {
    const requestId = callRequestId(at, raised + 1);
    const request = requests[requestId];
    if (request === undefined) return { raised, own };
    if (own === null && request.decision?.action !== 'cancel')
      own = { requestId, request };
  }
}

/** A response whose calls are not yet all settled and delivered. */
export type PendingResponse = {
  readonly responseId: string;
  /** The message it enters history as once its calls are settled. */
  readonly assistant: Extract<HistoryMessage, { readonly role: 'assistant' }>;
  /** The response's own calls, in order. Only their results enter history:
   *  the delivering append carries one per call. */
  readonly calls: readonly DispatchFacts[];
  /** Every call by id, the response's and its scripts' alike. */
  readonly records: Readonly<Record<string, PendingCall>>;
};

/** The settlement of `callId` the rows committed, or null. */
export const settlementOf = (
  pending: PendingResponse,
  callId: string,
): Extract<CallStatus, { kind: 'settled' }> | null => {
  const status = pending.records[callId]?.status;
  return status?.kind === 'settled' ? status : null;
};

/** The pending response row `p` opens, with every call issued. */
export function pendingResponseOf(
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
