// Third-party imports
import { Clock, Effect, Schema } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  ContinuationSchema,
  replayableHistory,
  systemUpdateText,
} from '../message.js';
import { sameModelOrigin } from '../protocol.js';
import { ModelError } from '../errors.js';
import { prefixFingerprint } from './prefixFingerprint.js';
import {
  responsesContent,
  type DocumentAccess,
} from './openaiResponsesCodec.js';
import type {
  OpenAIResponsesConfiguration,
  ResolvedTurn,
  TurnResult,
} from '../turn.js';
import type { UploadCache } from './uploadCache.js';

type ResponsesTurn = Extract<ResolvedTurn, { protocol: 'openai-responses' }>;
type ResponsesMessage = ResponsesTurn['messages'][number];

const documentAccess = Effect.fn('llm.responses.documentAccess')(function* (
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const nowMs = yield* Clock.currentTimeMillis;
  return {
    accepted: config.supportsDocumentInput,
    fileIdFor: (base64: string) =>
      uploads === null ? null : uploads.fileIdFor(base64, nowMs),
  } satisfies DocumentAccess;
});

/**
 * The items one admitted message lowers to: one per tool result, one per
 * user message, one per assistant content part. A continuation's covered
 * prefix is counted with this instead of lowered, so the bytes it covers
 * are never materialized again; a count that drifts from the lowering fails
 * the continuation's `coveredItems` check loudly.
 */
const loweredItemCount = (message: ResponsesMessage): number => {
  if (message.role === 'tool') return message.results.length;
  return message.role === 'assistant' ? message.content.length : 1;
};

/**
 * The call ids one message leaves for the next tool message, replayed
 * without lowering: any non-tool message resets the run, and an assistant
 * message then appends its local calls. A continuation's suffix lowers
 * against the ids its covered prefix left.
 */
const replayCallIds = (message: ResponsesMessage, callIds: string[]): void => {
  if (message.role === 'tool') return;
  callIds.length = 0;
  if (message.role !== 'assistant') return;
  for (const part of message.content) {
    if (part.kind === 'local-call') callIds.push(part.providerCallId);
  }
};

/**
 * One tool result as a function call's output. A settlement that carries
 * only text keeps the plain string output the API has always taken.
 * Attachments keep `result.content` order so a label still sits next to the
 * file it names.
 */
const toolOutput = Effect.fn('llm.responses.toolOutput')(function* (
  result: Extract<ResponsesMessage, { role: 'tool' }>['results'][number],
  documents: DocumentAccess,
): Effect.fn.Return<
  string | OpenAI.Responses.ResponseInputContent[],
  ModelError
> {
  if (result.content.every((part) => part.kind === 'text')) {
    const text = result.content.map((part) => part.text).join('');
    return result.status === 'error' ? `Error: ${text}` : text;
  }
  const lowered = yield* Effect.forEach(result.content, (part) =>
    responsesContent(part, documents),
  );
  return result.status === 'error'
    ? [{ type: 'input_text', text: 'Error: ' }, ...lowered]
    : lowered;
});

/**
 * One assistant content part as the input item that replays it. Message and
 * call evidence has a single kind, this protocol's own; reasoning replays
 * only with its original Responses evidence.
 */
const assistantItem = Effect.fn('llm.responses.assistantItem')(function* (
  part: TurnResult['content'][number],
): Effect.fn.Return<OpenAI.Responses.ResponseInputItem, ModelError> {
  switch (part.kind) {
    case 'message': {
      if (part.evidence) {
        return {
          type: 'message',
          role: 'assistant',
          id: part.evidence.itemId,
          status: part.evidence.status,
          ...(part.evidence.phase !== undefined
            ? { phase: part.evidence.phase }
            : {}),
          content: part.content.map((child) =>
            child.kind === 'text'
              ? { type: 'output_text', text: child.text, annotations: [] }
              : { type: 'refusal', refusal: child.text },
          ),
        };
      }
      if (part.content.some((child) => child.kind !== 'text')) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Responses refusal history requires its original message evidence.',
        });
      }
      return {
        role: 'assistant',
        content: part.content.map((child) => child.text).join(''),
      };
    }
    case 'reasoning': {
      if (part.evidence?.kind !== 'openai-responses-reasoning') {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Responses reasoning requires its original provider evidence.',
        });
      }
      return {
        type: 'reasoning',
        id: part.evidence.itemId,
        summary: part.summary.map((child) => ({
          type: 'summary_text',
          text: child.text,
        })),
        ...(part.content !== undefined
          ? {
              content: part.content.map((child) => ({
                type: 'reasoning_text' as const,
                text: child.text,
              })),
            }
          : {}),
        ...(part.evidence.status !== undefined
          ? { status: part.evidence.status }
          : {}),
        ...(part.evidence.encryptedContent !== undefined
          ? { encrypted_content: part.evidence.encryptedContent }
          : {}),
      };
    }
    case 'local-call':
      return {
        type: 'function_call',
        call_id: part.providerCallId,
        name: part.name,
        arguments: part.argumentsText,
        ...(part.evidence?.itemId !== undefined
          ? { id: part.evidence.itemId }
          : {}),
        ...(part.evidence?.status !== undefined
          ? { status: part.evidence.status }
          : {}),
      };
  }
});

/**
 * The messages as Responses input items. `callIds` is the mutable call-id
 * run the loop keeps: seeded with the ids a covered prefix left when
 * lowering only a continuation's suffix.
 */
const lowerMessages = Effect.fn('llm.responses.lowerMessages')(function* (
  turn: ResponsesTurn,
  messages: ResponsesTurn['messages'],
  config: OpenAIResponsesConfiguration,
  documents: DocumentAccess,
  callIds: string[],
) {
  const input: OpenAI.Responses.ResponseInput = [];
  for (const message of replayableHistory(messages, turn)) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        input.push({
          type: 'function_call_output',
          call_id: callIds[result.callOrdinal],
          output: yield* toolOutput(result, documents),
        });
      }
      continue;
    }
    callIds.length = 0;
    if (message.role === 'system') {
      // A developer message outranks user text; elsewhere it is user text.
      input.push(
        config.openaiEndpoint
          ? { role: 'developer', content: message.text }
          : { role: 'user', content: systemUpdateText(message.text) },
      );
      continue;
    }
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: yield* Effect.forEach(message.content, (part) =>
          responsesContent(part, documents),
        ),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.evidence != null && !sameModelOrigin(message.origin, turn)) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Provider content evidence belongs to another model origin.',
        });
      }
      const item = yield* assistantItem(part);
      if (part.kind === 'local-call') callIds.push(part.providerCallId);
      input.push(item);
    }
  }
  return input;
});

/** The required tool must be among the supplied definitions. */
const checkToolChoice = (
  turn: ResponsesTurn,
): Effect.Effect<void, ModelError> => {
  const choice = turn.controls.toolChoice;
  return choice === 'auto' ||
    turn.tools.some((tool) => tool.name === choice.name)
    ? Effect.void
    : Effect.fail(
        new ModelError({
          kind: 'invalid-request',
          message:
            'The required tool must be present in the supplied definitions.',
        }),
      );
};

const lowerInput = Effect.fn('llm.responses.lowerInput')(function* (
  turn: ResponsesTurn,
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const documents = yield* documentAccess(config, uploads);
  const input = yield* lowerMessages(
    turn,
    turn.messages,
    config,
    documents,
    [],
  );
  yield* checkToolChoice(turn);
  return input;
});

const RESPONSES_PREFIX_DOMAIN = 'texra-openai-responses-prefix-v1';

/**
 * The completed turn with the stored anchor its next round chains on, if the
 * route stores and the turn ended chainable. The configuration was parsed at
 * bind and the result by the turn assembly, so neither is parsed again.
 */
export const withResponsesContinuation = Effect.fn(
  'llm.responses.continuation',
)(function* (
  config: OpenAIResponsesConfiguration,
  turn: ResponsesTurn,
  result: TurnResult,
): Effect.fn.Return<TurnResult, ModelError> {
  if (!sameModelOrigin(turn, result.requestedOrigin))
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Continuation requires the original admitted input and matching completed output.',
    });
  // HTTP stored-response chaining is separate from temporary background retrieval.
  // https://developers.openai.com/api/docs/guides/conversation-state
  if (
    !config.supportsStorage ||
    !turn.controls.store ||
    (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')
  )
    return result;
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    {
      role: 'assistant',
      origin: result.requestedOrigin,
      content: result.content,
    },
  ];
  const continuation = Schema.decodeUnknownSync(ContinuationSchema)({
    origin: result.requestedOrigin,
    coveredMessages: prefix.length,
    prefixFingerprint: prefixFingerprint(
      RESPONSES_PREFIX_DOMAIN,
      result.requestedOrigin,
      turn.system,
      prefix,
    ),
    anchor: {
      kind: 'stored',
      responseId: result.providerResponseId,
      // Counted, not lowered: the covered prefix is never materialized
      // again, and the same count validates the continuation later.
      coveredItems: prefix.reduce(
        (count, message) => count + loweredItemCount(message),
        0,
      ),
    },
  });
  return { ...result, continuation };
});

/**
 * The turn's Responses `input`: every message lowered, or with a stored
 * continuation only the suffix it does not cover, chained to the stored
 * response by `previous_response_id`.
 */
export const responseInput = Effect.fn('llm.responses.input')(function* (
  turn: ResponsesTurn,
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const continuation = turn.continuation;
  if (!continuation) return { input: yield* lowerInput(turn, config, uploads) };
  const prefix = turn.messages.slice(0, continuation.coveredMessages);
  if (
    !sameModelOrigin(turn, continuation.origin) ||
    continuation.coveredMessages > turn.messages.length ||
    continuation.anchor.coveredItems !==
      prefix.reduce((count, message) => count + loweredItemCount(message), 0) ||
    continuation.prefixFingerprint !==
      prefixFingerprint(
        RESPONSES_PREFIX_DOMAIN,
        continuation.origin,
        turn.system,
        prefix,
      )
  )
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'Continuation does not cover the exact admitted prefix.',
    });
  // The stored response already holds the covered prefix, so only the
  // uncovered suffix is lowered: a covered document's bytes are never
  // materialized again. The suffix still lowers against the call ids the
  // prefix's last assistant message left.
  const callIds: string[] = [];
  for (const message of prefix) replayCallIds(message, callIds);
  const documents = yield* documentAccess(config, uploads);
  const input = yield* lowerMessages(
    turn,
    turn.messages.slice(continuation.coveredMessages),
    config,
    documents,
    callIds,
  );
  yield* checkToolChoice(turn);
  return {
    input,
    previous_response_id: continuation.anchor.responseId,
  };
});
