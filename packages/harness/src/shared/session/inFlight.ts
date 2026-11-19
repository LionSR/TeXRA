/**
 * What a run has in flight between asking and delivering. First the model
 * invocation: its attempts as their rows left them, and the one function
 * that reads its next step off them (`nextAttempt`), so the invoker's retry
 * loop holds no state of its own and a resume restarts the turn's request
 * from the last outcome its rows recorded. Then the response it stands on until its calls finish: a
 * model's `response`, or the `handed-down` call a script's run opens on,
 * which no model made, so its assistant message has a null origin.
 */
import type {
  CommitOrdinal,
  DeclinableUsageRoute,
  DispatchFacts,
  StepAfterFailure,
  InvocationRef,
  RequestDecision,
  ModelFailure,
  ScriptCallPayload,
  ToolResultPayload,
} from '@shared/schemas';
import { Result } from 'effect';

import type { ModelOrigin, RemoteOperation } from '@texra-ai/llm';
import type { RunRowState } from './runRowsShape';
import type { HistoryMessage, ModelMessagePayload } from './historyTurns';
import type { RowRejection } from './runState';

/** How an attempt ended, as its `failed` row records it. */
export type Failure = {
  readonly error: ModelFailure;
  readonly next: StepAfterFailure;
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
  /** The background operation a resume observes; `cancelled` retires it. */
  readonly accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  } | null;
  /** Its `failed` row, or null while its outcome is unknown. */
  readonly failed: Failure | null;
};

/**
 * A model invocation: the attempt its rows last opened and the recorded
 * failures of the ones before it. An attempt no row saw end (the process
 * died or its run stopped while it ran) counts as not made. It closes with
 * its response, or, once it stopped, with the input of the next turn.
 */
export type Invocation = {
  readonly current: Attempt;
  readonly earlier: readonly Failure[];
};

type InvocationRow = Extract<
  ModelMessagePayload,
  {
    kind: 'attempt' | 'accepted' | 'cancelled' | 'failed' | 'response';
  }
>;

const sameRef = (a: InvocationRef, b: InvocationRef): boolean =>
  a.invocationId === b.invocationId && a.attempt === b.attempt;

/**
 * The recorded failures of `invocation`'s attempts before `ref`: its
 * earlier ones, and its current one's unless `ref` is that one.
 */
export function failuresBefore(
  invocation: Invocation | null,
  ref: InvocationRef,
): readonly Failure[] {
  if (invocation === null) return [];
  const { current, earlier } = invocation;
  return sameRef(current.ref, ref) || current.failed === null
    ? earlier
    : [...earlier, current.failed];
}

/** A row out of the order the run history writes. */
export const outOfOrder = (
  detail: string,
): Result.Result<never, RowRejection> =>
  Result.fail({ reason: 'out-of-order', detail });

/** The invocation after its row `p` (null: its response closed it), or why
 *  `p` cannot follow it. An `attempt` row opens the next attempt; so does a
 *  `failed` row naming it, for an attempt that failed before it was sent. */
export function invocationAfter(
  invocation: Invocation | null,
  p: InvocationRow,
): Result.Result<Invocation | null, RowRejection> {
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
): Result.Result<Invocation, RowRejection> {
  const { invocationId, attempt } = p.invocation;
  const prior = invocation?.current.ref;
  const follows =
    attempt === 1
      ? invocation === null
      : prior?.invocationId === invocationId && attempt === prior.attempt + 1;
  if (!follows)
    return outOfOrder(
      `${p.kind} ${attempt} of ${invocationId} does not follow ${prior?.attempt ?? 'no attempt'}`,
    );
  return Result.succeed({
    current: {
      ref: p.invocation,
      sent:
        p.kind === 'attempt' ? { request: p.request, origin: p.origin } : null,
      accepted: null,
      failed: p.kind === 'failed' ? { error: p.error, next: p.next } : null,
    },
    earlier: failuresBefore(invocation, p.invocation),
  });
}

/** The invocation after `p` moves or closes its open attempt. */
function movedBy(
  invocation: Invocation | null,
  p: InvocationRow,
): Result.Result<Invocation | null, RowRejection> {
  const current = invocation?.current;
  if (
    invocation == null ||
    current === undefined ||
    current.failed !== null ||
    !sameRef(current.ref, p.invocation)
  )
    return outOfOrder(`${p.kind} names no open attempt`);
  const moved = (patch: Partial<Attempt>) =>
    Result.succeed<Invocation>({
      ...invocation,
      current: { ...current, ...patch },
    });
  switch (p.kind) {
    case 'attempt':
      return outOfOrder('an attempt row moves no attempt');
    case 'accepted':
      return moved({
        accepted: { operation: p.operation, deadlineAtMs: p.deadlineAtMs },
      });
    case 'cancelled':
      return current.accepted === null
        ? outOfOrder('cancelled names no accepted operation')
        : moved({ accepted: null });
    case 'failed':
      return moved({ failed: { error: p.error, next: p.next } });
    case 'response':
      return Result.succeed(null);
  }
}

/** The credentials a person's retry is sent on, and the route it declines:
 *  personal credentials decline the route its request offered to switch
 *  off. */
export interface RetryCredentials {
  readonly credentials: NonNullable<
    Extract<RequestDecision, { action: 'retry' }>['credentials']
  >;
  readonly declines: DeclinableUsageRoute | null;
}

/**
 * What an invocation does next: `send` a new attempt (`retry`: after a
 * person's answer, which rebinds first), `observe` the accepted background
 * operation, `await` the answer to the open retry request, or end it
 * (`fail`, `cancel`).
 */
export type NextAttempt =
  | { readonly kind: 'send'; readonly retry: RetryCredentials | null }
  | {
      readonly kind: 'observe';
      readonly attempt: Attempt & {
        readonly accepted: NonNullable<Attempt['accepted']>;
      };
    }
  | { readonly kind: 'await'; readonly requestId: string }
  | { readonly kind: 'fail'; readonly error: ModelFailure }
  | { readonly kind: 'cancel' };

const SEND: NextAttempt = { kind: 'send', retry: null };

/** The automatic retries `failures` spent: one per recorded failure but a
 *  lost chain's, which is resent once outside them. */
const spentRetries = (failures: readonly Failure[]): number =>
  failures.filter((failure) => failure.next.kind !== 'unchain').length;

/**
 * What `invocation` does next (null: a new one), from its rows, the run's
 * `requests` and the `seq` of the run's latest activation (`activatedAt`).
 * An attempt no row saw end counts as not made and is sent again. An
 * accepted background operation is observed, never resubmitted.
 */
export function nextAttempt(
  invocation: Invocation | null,
  requests: RunRowState['requests'],
  activatedAt: number | null,
): NextAttempt {
  if (invocation === null) return SEND;
  const { current } = invocation;
  const { failed, accepted } = current;
  if (failed === null)
    return accepted === null
      ? SEND
      : { kind: 'observe', attempt: { ...current, accepted } };
  switch (failed.next.kind) {
    case 'retry':
    case 'unchain':
      return SEND;
    case 'stop':
      return { kind: 'fail', error: failed.error };
    case 'ask': {
      const { requestId } = failed.next;
      const request = requests[requestId];
      const decision = request?.decision ?? null;
      if (decision === null) return { kind: 'await', requestId };
      if (decision.action === 'retry') {
        const credentials = decision.credentials ?? 'configured';
        const offer =
          request?.payload.kind === 'retry'
            ? request.payload.data.credentialSwitch
            : null;
        return {
          kind: 'send',
          retry: {
            credentials,
            declines:
              credentials === 'personal' && offer?.kind === 'decline-route'
                ? offer.route
                : null,
          },
        };
      }
      if (decision.action === 'deny')
        return { kind: 'fail', error: failed.error };
      // A cancel from before this activation is not the person's answer to
      // this owner: a run's end cancels every request it leaves open, an
      // activation those a dead process left, and a person's cancel ended
      // the lifecycle it was given in. Resuming the run is the person's
      // word to go on, so the request is sent again, unasked.
      const decidedAt = request?.decidedAt ?? null;
      return activatedAt !== null &&
        decidedAt !== null &&
        decidedAt < activatedAt
        ? SEND
        : { kind: 'cancel' };
    }
  }
}

/** What one failure says about the step after it. */
interface FailureFacts {
  /** The vendor no longer holds the response this attempt chained on;
   *  true only for an attempt that sent a continuation. */
  readonly unchain: boolean;
  /** The same request may succeed when sent again. */
  readonly automatic: boolean;
  /** A person may be offered a retry. */
  readonly offered: boolean;
}

/**
 * What follows a failed attempt, recorded on its `failed` row, given the
 * recorded failures before it (`failuresBefore`): `retries` automatic
 * resends per invocation, counted from its rows ({@link spentRetries}), and
 * a lost chain's once outside them; past them, the person is asked under
 * `requestId`, or, where nobody can be asked (null), it stops.
 */
export function failedNext(
  before: readonly Failure[],
  facts: FailureFacts,
  retries: number,
  requestId: string | null,
): StepAfterFailure {
  // Once per invocation: the resend after it carries no continuation.
  if (
    facts.unchain &&
    !before.some((failure) => failure.next.kind === 'unchain')
  )
    return { kind: 'unchain' };
  if (facts.automatic && spentRetries(before) < retries)
    return { kind: 'retry' };
  return facts.offered && requestId !== null
    ? { kind: 'ask', requestId }
    : { kind: 'stop' };
}

/** A call's result, as its `tool.result` row records it. */
export type ToolCallResult = Pick<
  ToolResultPayload,
  'attempt' | 'disposition' | 'duplicateOf' | 'result' | 'attachments'
>;

/** How far one call got, as its rows say: `issued`, no body started;
 *  `started`, the `tool.intent` of `attempt` committed, so the body may
 *  have run; `finished`, its `tool.result` committed at `at`. */
export type CallStatus =
  | { readonly kind: 'issued' }
  | { readonly kind: 'started'; readonly attempt: number }
  | ({
      readonly kind: 'finished';
      readonly at: CommitOrdinal;
    } & ToolCallResult);

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
export type CallAttempt = Pick<
  ToolResultPayload,
  'responseId' | 'callId' | 'attempt'
>;

/** The id of the `ordinal`-th request (from 1) `at` raises: derived, never
 *  drawn, so a call's requests are found from its rows. */
export const callRequestId = (at: CallAttempt, ordinal: number): string =>
  `${at.responseId}/${at.callId}:${at.attempt}:${ordinal}`;

/** What one attempt asked: `raised` requests (ordinals 1..raised), and the
 *  `last` of them. A request is asked once: one a stop or a resume
 *  cancelled is asked again under the next ordinal. */
export interface AttemptRequests {
  readonly raised: number;
  readonly last: {
    readonly requestId: string;
    readonly request: RunRowState['requests'][string];
  } | null;
}

/** The attempt a call runs at and what it asked; `mayHaveRun`, a started
 *  body that got past what it asked ({@link resumedAttempt}); `answer`, the
 *  last request when a person answered it while no process held the run,
 *  which the attempt takes when it asks the same again. */
type ResumedAttempt = AttemptRequests & {
  readonly attempt: number;
  readonly mayHaveRun: boolean;
  readonly answer: AttemptRequests['last'];
};

/** What `at` has asked, read off the run's `requests` by derived id. */
export function attemptRequests(
  requests: RunRowState['requests'],
  at: CallAttempt,
): AttemptRequests {
  let last: AttemptRequests['last'] = null;
  for (let raised = 0; ; raised += 1) {
    const requestId = callRequestId(at, raised + 1);
    const request = requests[requestId];
    if (request === undefined) return { raised, last };
    last = { requestId, request };
  }
}

/** The attempt a resume runs an unfinished call at. Whatever was in flight
 *  counts as not done: an unstarted body runs at its next attempt, and a
 *  started one whose last request no asker read an answer to was waiting on
 *  it, so it runs again from its start and asks again. Such a request is
 *  open, cancelled when its run stopped or resumed, or answered after the
 *  run's latest activation: a person's answer to a run no process held,
 *  which that activation commits behind its `run.activate` (an asker that
 *  was waiting read its decision before any later activation). Any other
 *  started body may have run. */
export function resumedAttempt(
  state: {
    readonly requests: RunRowState['requests'];
    readonly activatedAt: number | null;
  },
  at: Omit<CallAttempt, 'attempt'>,
  status: Exclude<CallStatus, { kind: 'finished' }>,
): ResumedAttempt {
  const asked = (attempt: number) => {
    const requests = attemptRequests(state.requests, { ...at, attempt });
    const { decision, decidedAt } = requests.last?.request ?? {};
    const unread =
      decision != null &&
      decision.action !== 'cancel' &&
      decidedAt != null &&
      state.activatedAt !== null &&
      decidedAt > state.activatedAt;
    return {
      attempt,
      mayHaveRun: false,
      answer: unread ? requests.last : null,
      ...requests,
    };
  };
  const next = asked(attemptOf(status) + 1);
  if (status.kind === 'issued' || next.raised > 0) return next;
  const started = asked(status.attempt);
  const decision = started.last?.request.decision ?? null;
  const waiting =
    started.last !== null &&
    (decision === null ||
      decision.action === 'cancel' ||
      started.answer !== null);
  return waiting ? started : { ...next, mayHaveRun: true };
}

/** A response whose calls are not yet all finished and delivered. */
export type PendingResponse = {
  readonly responseId: string;
  /** The message it enters history as once its calls are finished. */
  readonly assistant: Extract<HistoryMessage, { readonly role: 'assistant' }>;
  /** The response's own calls, in order. Only their results enter history:
   *  the delivering append carries one per call. */
  readonly calls: readonly DispatchFacts[];
  /** Every call by id, the response's and its scripts' alike. */
  readonly records: Readonly<Record<string, PendingCall>>;
};

/** The result of `callId` the rows committed, or null. */
export const callResultOf = (
  pending: PendingResponse,
  callId: string,
): Extract<CallStatus, { kind: 'finished' }> | null => {
  const status = pending.records[callId]?.status;
  return status?.kind === 'finished' ? status : null;
};

/** A call's committed result asks to end the turn (`submit_output`'s). */
export const endsTurn = (
  recorded: Pick<ToolCallResult, 'result'> | null,
): boolean =>
  recorded?.result.status === 'executed' && recorded.result.endTurn === true;

/** One of the response's own calls (never a script's) ended the turn by
 *  its result. */
export const resultsEndTurn = (pending: PendingResponse): boolean =>
  pending.calls.some(({ callId }) => endsTurn(callResultOf(pending, callId)));
