/**
 * OpenRouter Chat Completions on the wire, as the API spells it (snake_case).
 * `openrouterChat.ts` encodes its request through `ChatRequestSchema` and
 * decodes each payload `sseData` yields through `ChatStreamChunkSchema`; the
 * spec-drift suite (`test-live/openrouterSpec.live.ts`) checks both against
 * OpenRouter's published OpenAPI document. An undeclared field is dropped at
 * decode, as it was by the SDK this replaces.
 */

import { Effect, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';

const nullish = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

const detailFields = {
  format: nullish(Schema.String),
  id: nullish(Schema.String),
  index: Schema.optional(Schema.Int),
};

/** One reasoning detail, as OpenRouter returns it and takes it back on replay. */
const ReasoningDetailSchema = Schema.Union([
  Schema.Struct({
    ...detailFields,
    type: Schema.Literal('reasoning.text'),
    text: nullish(Schema.String),
    signature: nullish(Schema.String),
  }),
  Schema.Struct({
    ...detailFields,
    type: Schema.Literal('reasoning.summary'),
    summary: Schema.String,
  }),
  Schema.Struct({
    ...detailFields,
    type: Schema.Literal('reasoning.encrypted'),
    data: Schema.String,
  }),
  Schema.Struct({
    ...detailFields,
    type: Schema.Literal('reasoning.server_tool_call'),
    tool_name: Schema.String,
    tool_call_id: nullish(Schema.String),
    arguments: Schema.String,
    result: Schema.String,
  }),
]);
/** One reasoning detail on the wire. */
export type ReasoningDetail = typeof ReasoningDetailSchema.Type;

const UsageSchema = Schema.Struct({
  prompt_tokens: Schema.Int,
  completion_tokens: Schema.Int,
  total_tokens: Schema.Int,
  cost: nullish(Schema.Finite),
  is_byok: Schema.optional(Schema.Boolean),
  prompt_tokens_details: nullish(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Int),
      cache_write_tokens: Schema.optional(Schema.Int),
    }),
  ),
  completion_tokens_details: nullish(
    Schema.Struct({ reasoning_tokens: nullish(Schema.Int) }),
  ),
});
/** A usage receipt on the wire. */
export type ChatUsage = typeof UsageSchema.Type;

const StreamToolCallSchema = Schema.Struct({
  index: Schema.Int,
  id: Schema.optional(Schema.String),
  function: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.String),
    }),
  ),
});

const StreamChoiceSchema = Schema.Struct({
  index: Schema.Int,
  // An open set: the adapter refuses a reason it does not know.
  finish_reason: Schema.NullOr(Schema.String),
  logprobs: Schema.optional(Schema.Unknown),
  delta: Schema.Struct({
    content: nullish(Schema.String),
    refusal: nullish(Schema.String),
    reasoning: nullish(Schema.String),
    reasoning_details: Schema.optional(Schema.Array(ReasoningDetailSchema)),
    audio: Schema.optional(Schema.Unknown),
    tool_calls: Schema.optional(Schema.Array(StreamToolCallSchema)),
  }),
});

/** One SSE `data` payload of a streamed completion, once parsed as JSON. */
export const ChatStreamChunkSchema = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  object: Schema.Literal('chat.completion.chunk'),
  created: Schema.Int,
  system_fingerprint: Schema.optional(Schema.String),
  usage: Schema.optional(UsageSchema),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Int,
      message: Schema.String,
      metadata: Schema.optional(Schema.Unknown),
    }),
  ),
  choices: Schema.Array(StreamChoiceSchema),
});
/** One decoded stream chunk. */
export type ChatStreamChunk = typeof ChatStreamChunkSchema.Type;

const ContentItemSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('image_url'),
    image_url: Schema.Struct({
      url: Schema.String,
      detail: Schema.optional(Schema.Literals(['low', 'high'])),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('file'),
    file: Schema.Struct({ file_data: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal('input_audio'),
    input_audio: Schema.Struct({ data: Schema.String, format: Schema.String }),
  }),
]);
/** One part of a user message's content. */
export type ContentItem = typeof ContentItemSchema.Type;

const MessageSchema = Schema.Union([
  Schema.Struct({ role: Schema.Literal('system'), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal('user'),
    content: Schema.Union([Schema.String, Schema.Array(ContentItemSchema)]),
  }),
  Schema.Struct({
    role: Schema.Literal('tool'),
    tool_call_id: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({
    role: Schema.Literal('assistant'),
    content: Schema.String,
    refusal: Schema.optional(Schema.String),
    reasoning: nullish(Schema.String),
    reasoning_details: Schema.optional(Schema.Array(ReasoningDetailSchema)),
    tool_calls: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal('function'),
          function: Schema.Struct({
            name: Schema.String,
            arguments: Schema.String,
          }),
        }),
      ),
    ),
  }),
]);
/** One message of a request. */
export type ChatMessage = typeof MessageSchema.Type;

/** A streamed Chat Completions request body. */
export const ChatRequestSchema = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(MessageSchema),
  stream: Schema.Literal(true),
  max_completion_tokens: Schema.Int,
  temperature: Schema.optional(Schema.Finite),
  reasoning: Schema.optional(Schema.Struct({ effort: Schema.String })),
  stop: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal('function'),
        function: Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          parameters: Schema.Unknown,
          strict: Schema.Boolean,
        }),
      }),
    ),
  ),
  tool_choice: Schema.optional(
    Schema.Union([
      Schema.Literal('auto'),
      Schema.Struct({
        type: Schema.Literal('function'),
        function: Schema.Struct({ name: Schema.String }),
      }),
    ]),
  ),
});
/** A streamed Chat Completions request body. */
export type ChatRequest = typeof ChatRequestSchema.Type;

/** The SSE `data` that ends a stream. */
const DONE = '[DONE]';

/**
 * A streamed response body's SSE `data` payloads, ending before `[DONE]`:
 * nothing after the sentinel is passed on, even from the same bytes. A
 * `retry:` directive is ignored, since a turn is never reconnected, which is
 * why this feeds Effect's SSE parser rather than piping through `Sse.decode`,
 * whose stream ends on one.
 */
export const sseData = <E>(
  body: Stream.Stream<Uint8Array, E>,
): Stream.Stream<string, E | Sse.SseError> =>
  Stream.suspend(() => {
    const data: string[] = [];
    const parser = Sse.makeParser((event) => {
      if (event._tag === 'Event') data.push(event.data);
    });
    return body.pipe(
      Stream.decodeText,
      Stream.mapEffect((text) => {
        const tooLarge = parser.feed(text);
        return tooLarge === undefined
          ? Effect.succeed(data.splice(0))
          : Effect.fail(tooLarge);
      }),
      Stream.flattenIterable,
      Stream.takeWhile((payload) => payload !== DONE),
    );
  });
