/**
 * What a run has in flight between asking and delivering. The attempt it
 * has sent and not yet seen answered, and how the provider rows committed
 * before its response move it: `identified` names the provider's response,
 * `accepted` holds the background operation a resume observes, and
 * `cancelled` retires that operation after a user stop, so a resume submits
 * anew instead of observing work the user stopped. Then the response it
 * stands on until its calls settle: a model's `response`, or the
 * `handed-down` call a script's run opens on, which no model made, so its
 * assistant message has a null origin.
 */
import {
  assistantMessageFromResult,
  type ModelOrigin,
  type RemoteOperation,
} from '@texra-ai/llm';
import type {
  CommitOrdinal,
  DispatchFacts,
  InvocationRef,
  ScriptCallPayload,
  ToolBindingPayload,
  ToolResultPayload,
} from '@shared/schemas';
import { byId } from './runRows';
import type { HistoryMessage, ModelMessagePayload } from './historyTurns';

/** The attempt a run has sent and not yet seen answered. */
export type OpenAttempt = {
  readonly invocation: InvocationRef;
  readonly request: string; // its recorded request's address
  readonly origin: ModelOrigin;
  readonly delivery: 'stream' | 'blocking' | 'background';
  readonly providerResponseId: string | null;
  readonly returnedModel: string | null;
  readonly accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  } | null;
};

type ProviderRow = Extract<
  ModelMessagePayload,
  { kind: 'identified' | 'accepted' | 'cancelled' }
>;

/** The open attempt after provider row `p`, or why `p` cannot follow it. */
export function openAttemptAfter(
  open: OpenAttempt,
  p: ProviderRow,
): OpenAttempt | string {
  switch (p.kind) {
    case 'identified':
      return {
        ...open,
        providerResponseId: p.providerResponseId,
        returnedModel: p.returnedModel,
      };
    case 'accepted':
      return {
        ...open,
        accepted: { operation: p.operation, deadlineAtMs: p.deadlineAtMs },
      };
    case 'cancelled':
      return open.accepted === null
        ? 'cancelled names no accepted operation'
        : { ...open, accepted: null };
  }
}

type Settlement = Pick<
  ToolResultPayload,
  'attempt' | 'disposition' | 'duplicateOf' | 'result' | 'attachments'
>;

/**
 * How far one call got, as its rows say. `issued`: nothing of it ran.
 * `asking`: its own request for `attempt` is open or answered, and its body
 * has not started, so whatever the answer, nothing happened yet.
 * `started`: the `tool.intent` of `attempt` committed as its body began, so
 * the body may have run; `binding` is the call's own request that attempt
 * is bound to (its guard's approval, or the first its body raised).
 * `settled`: its `tool.result`, at commit `at`.
 */
export type CallStatus =
  | { readonly kind: 'issued' }
  | {
      readonly kind: 'asking';
      readonly attempt: number;
      readonly requestId: string;
    }
  | {
      readonly kind: 'started';
      readonly attempt: number;
      readonly binding: Pick<ToolBindingPayload, 'requestId'> | null;
    }
  | ({ readonly kind: 'settled'; readonly at: CommitOrdinal } & Settlement);

/** One call of the pending response, the same record whichever issued it:
 *  the response (`script` null) or one of its `script` calls' guests, whose
 *  `script.call` row it carries. */
export type PendingCall = {
  readonly script: ScriptCallPayload | null;
  readonly status: CallStatus;
};

/** The request a call's current attempt stands bound to, or null: its own
 *  while it asks, else the attempt's binding. */
export const boundRequestOf = (
  status: CallStatus,
): Pick<ToolBindingPayload, 'requestId'> | null => {
  if (status.kind === 'asking') return { requestId: status.requestId };
  return status.kind === 'started' ? status.binding : null;
};

/** The attempt a call's rows have reached: 0 before any asked or started. */
export const attemptOf = (status: CallStatus): number =>
  status.kind === 'issued' ? 0 : status.attempt;

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
