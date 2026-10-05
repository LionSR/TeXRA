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
  ToolResultPayload,
} from '@shared/schemas';
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

/** A call a `script` call's guest issued, as its `script.call` row recorded
 *  it, and the commit of its settlement once one is recorded: a resumed
 *  script is handed its settled calls in that order. */
type ScriptCall = ScriptCallPayload & {
  readonly settledAt: CommitOrdinal | null;
};

/** A response whose calls are not yet all settled and delivered. */
export type PendingResponse = {
  readonly responseId: string;
  /** The message it enters history as once its calls are settled. */
  readonly assistant: Extract<HistoryMessage, { readonly role: 'assistant' }>;
  readonly calls: readonly DispatchFacts[];
  /** The calls its `script` calls issued, by call id. None enters history:
   *  the delivering append carries the results of `calls` alone. */
  readonly scriptCalls: Readonly<Record<string, ScriptCall>>;
  /** Committed settlements by call id, exactly one per settled call, a
   *  script's calls included. */
  readonly settled: Readonly<Record<string, Settlement>>;
};

/** The pending response row `p` opens, with nothing settled yet. */
export function pendingResponseOf(
  p: Extract<ModelMessagePayload, { kind: 'response' | 'handed-down' }>,
): PendingResponse {
  const opened = {
    responseId: p.responseId,
    scriptCalls: {},
    settled: {},
  };
  if (p.kind === 'response')
    return {
      ...opened,
      assistant: assistantMessageFromResult(p.turn),
      calls: p.calls,
    };
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
    calls: [call],
  };
}
