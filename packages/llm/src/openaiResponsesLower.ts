// Third-party imports
import { Clock, Effect } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  ModelConfigurationSchema,
  TurnResultSchema,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnResult,
} from './turn.js';
import { ContinuationSchema, type Continuation } from './message.js';
import { sameModelOrigin } from './protocol.js';
import { ModelError } from './errors.js';
import { prefixFingerprint } from './prefixFingerprint.js';
import {
  responsesContent,
  type DocumentAccess,
} from './openaiResponsesCodec.js';
import type { UploadCache } from './uploadCache.js';

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
const loweredItemCount = (
  message: Extract<
    ResolvedTurn,
    { protocol: 'openai-responses' }
  >['messages'][number],
): number => {
  if (message.role === 'tool') return message.results.length;
  return message.role === 'user' ? 1 : message.content.length;
};

/**
 * The call ids one message leaves for the next tool message, replayed
 * without lowering: any non-tool message resets the run, and an assistant
 * message then appends its local calls. A continuation's suffix lowers
 * against the ids its covered prefix left.
 */
const replayCallIds = (
  message: Extract<
    ResolvedTurn,
    { protocol: 'openai-responses' }
  >['messages'][number],
  callIds: string[],
): void => {
  if (message.role === 'tool') return;
  callIds.length = 0;
  if (message.role !== 'assistant') return;
  for (const part of message.content) {
    if (part.kind === 'local-call') callIds.push(part.providerCallId);
  }
};

/**
 * The messages as Responses input items. `callIds` is the mutable call-id
 * run the loop keeps: seeded with the ids a covered prefix left when
 * lowering only a continuation's suffix.
 */
const lowerMessages = Effect.fn('llm.responses.lowerMessages')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  messages: Extract<ResolvedTurn, { protocol: 'openai-responses' }>['messages'],
  documents: DocumentAccess,
  callIds: string[],
) {
  const content = (part: Parameters<typeof responsesContent>[0]) =>
    responsesContent(part, documents);
  const input: OpenAI.Responses.ResponseInput = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        // A settlement that carries only text keeps the plain string output
        // the API has always taken. Attachments keep `result.content` order
        // so a label still sits next to the file it names.
        let output: string | OpenAI.Responses.ResponseInputContent[];
        if (result.content.every((part) => part.kind === 'text')) {
          const text = result.content.map((part) => part.text).join('');
          output = result.status === 'error' ? `Error: ${text}` : text;
        } else {
          const lowered = yield* Effect.forEach(result.content, content);
          output =
            result.status === 'error'
              ? [{ type: 'input_text' as const, text: 'Error: ' }, ...lowered]
              : lowered;
        }
        input.push({
          type: 'function_call_output',
          call_id: callIds[result.callOrdinal],
          output,
        });
      }
      continue;
    }
    callIds.length = 0;
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: yield* Effect.forEach(message.content, content),
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
      switch (part.kind) {
        case 'message': {
          if (part.evidence) {
            if (part.evidence.kind !== 'openai-responses-message') {
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Responses cannot replay foreign message evidence.',
              });
            }
            input.push({
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
            });
          } else {
            const text: string[] = [];
            for (const child of part.content) {
              if (child.kind !== 'text') {
                return yield* new ModelError({
                  kind: 'unsupported',
                  message:
                    'Responses refusal history requires its original message evidence.',
                });
              }
              text.push(child.text);
            }
            input.push({ role: 'assistant', content: text.join('') });
          }
          break;
        }
        case 'reasoning': {
          if (part.evidence?.kind !== 'openai-responses-reasoning') {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Responses reasoning requires its original provider evidence.',
            });
          }
          input.push({
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
          });
          break;
        }
        case 'local-call': {
          if (
            part.evidence !== undefined &&
            part.evidence.kind !== 'openai-responses-function-call'
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Responses tool history requires local calls without foreign evidence.',
            });
          }
          callIds.push(part.providerCallId);
          input.push({
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
          });
          break;
        }
      }
    }
  }
  return input;
});

/** The required tool must be among the supplied definitions. */
const checkToolChoice = (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
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
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const documents = yield* documentAccess(config, uploads);
  const input = yield* lowerMessages(turn, turn.messages, documents, []);
  yield* checkToolChoice(turn);
  return input;
});

export const RESPONSES_PREFIX_DOMAIN = 'texra-openai-responses-prefix-v1';

/** Builds only a stored anchor, using the same selected configuration as admission. */
export const openaiResponsesContinuation = Effect.fn(
  'llm.responses.continuation',
)(function* (
  configuration: OpenAIResponsesConfiguration,
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  completed: TurnResult,
): Effect.fn.Return<Continuation | undefined, ModelError> {
  const parsedConfiguration = ModelConfigurationSchema.safeParse(configuration);
  const parsedResult = TurnResultSchema.safeParse(completed);
  if (
    !parsedConfiguration.success ||
    parsedConfiguration.data.protocol !== 'openai-responses' ||
    !parsedResult.success ||
    parsedResult.data.providerResponseId === null ||
    !sameModelOrigin(turn, parsedResult.data.requestedOrigin) ||
    !sameModelOrigin(turn, {
      ...parsedConfiguration.data,
      codecVersion: 1,
    })
  )
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Continuation requires the original admitted input and matching completed output.',
    });
  const result = parsedResult.data;
  // HTTP stored-response chaining is separate from temporary background retrieval.
  // https://developers.openai.com/api/docs/guides/conversation-state
  if (
    !parsedConfiguration.data.supportsResponseChaining ||
    !parsedConfiguration.data.supportsStorage ||
    !turn.controls.store ||
    (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')
  )
    return undefined;
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    {
      role: 'assistant',
      origin: result.requestedOrigin,
      content: result.content,
    },
  ];
  return ContinuationSchema.parse({
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
});

export const responseInput = Effect.fn('llm.responses.input')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
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
    documents,
    callIds,
  );
  yield* checkToolChoice(turn);
  return {
    input,
    previous_response_id: continuation.anchor.responseId,
  };
});
