/**
 * The Anthropic Messages API as it arrives on the wire: the streamed events,
 * their content blocks, the usage and the stop facts. `anthropicMessages.ts`
 * decodes these into canonical parts.
 */
// Third-party imports
import { Schema, Struct } from 'effect';
import type {
  CacheCreation,
  OutputTokensDetails,
  RefusalStopDetails,
  StopReason,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

// Local imports
import { CountSchema, JsonObjectSchema } from '../protocol.js';

/** A count the API may leave out or send as null. */
const ReportedCountSchema = Schema.optional(Schema.NullOr(CountSchema));
const RefusalSchema = Schema.Struct({
  type: Schema.Literal('refusal'),
  category: Schema.NullOr(
    Schema.Literals([
      'cyber',
      'bio',
      'frontier_llm',
      'reasoning_extraction',
      'general_harms',
    ]),
  ),
  explanation: Schema.NullOr(Schema.String),
});
/** A response's token counts, each reported, omitted or null. */
export const UsageSchema = Schema.Struct({
  input_tokens: ReportedCountSchema,
  output_tokens: ReportedCountSchema,
  cache_creation_input_tokens: ReportedCountSchema,
  cache_read_input_tokens: ReportedCountSchema,
  cache_creation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ephemeral_5m_input_tokens: ReportedCountSchema,
        ephemeral_1h_input_tokens: ReportedCountSchema,
      }),
    ),
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        thinking_tokens: ReportedCountSchema,
      }),
    ),
  ),
  server_tool_use: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, CountSchema)),
  ),
});
/** Why a response ended, with the refusal detail when it refused. */
export const StopSchema = Schema.Struct({
  stop_reason: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        'end_turn',
        'max_tokens',
        'tool_use',
        'pause_turn',
        'refusal',
        'model_context_window_exceeded',
      ]),
    ),
  ),
  stop_details: Schema.optional(Schema.NullOr(RefusalSchema)),
  container: Schema.optional(Schema.Unknown),
});
/** One content block of a response. */
export const BlockSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.String,
    citations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  }),
  Schema.Struct({
    type: Schema.Literal('thinking'),
    thinking: Schema.String,
    signature: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('redacted_thinking'),
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('tool_use'),
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    input: JsonObjectSchema,
    caller: Schema.optional(Schema.Struct({ type: Schema.Literal('direct') })),
    toolset_name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
// The SDK parses SSE JSON but does not validate its supported event/block fields.
/** One event of a streamed `messages.create` response. */
export const EventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('message_start'),
    message: StopSchema.mapFields(
      Struct.assign({
        id: Schema.NonEmptyString,
        model: Schema.NonEmptyString,
        type: Schema.Literal('message'),
        role: Schema.Literal('assistant'),
        content: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0)),
        usage: UsageSchema,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('message_delta'),
    delta: StopSchema,
    usage: UsageSchema,
  }),
  Schema.Struct({ type: Schema.Literal('message_stop') }),
  Schema.Struct({
    type: Schema.Literal('content_block_start'),
    index: CountSchema,
    content_block: BlockSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('content_block_delta'),
    index: CountSchema,
    delta: Schema.Union([
      Schema.Struct({
        type: Schema.Literal('text_delta'),
        text: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('thinking_delta'),
        thinking: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('signature_delta'),
        signature: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('input_json_delta'),
        partial_json: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal('content_block_stop'),
    index: CountSchema,
  }),
]);

/** The event types `EventSchema` decodes; the record's key type keeps them in step. */
export const EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    message_start: true,
    message_delta: true,
    message_stop: true,
    content_block_start: true,
    content_block_delta: true,
    content_block_stop: true,
  } satisfies Record<(typeof EventSchema.Type)['type'], true>),
);

type AssertNever<T extends never> = T;
type WireStopReason = NonNullable<typeof StopSchema.Type.stop_reason>;
type WireRefusal = NonNullable<typeof RefusalSchema.Type.category>;
type WireUsage = typeof UsageSchema.Type;

/**
 * The SDK's types pin these runtime lists, so an SDK upgrade that renames,
 * adds or drops one fails the typecheck here. The schemas stay: the SDK
 * types the stream but validates none of it. `stop_sequence` is the one
 * stop reason left out, since no request sends `stop_sequences`.
 */
type _WireMatchesSdk = AssertNever<
  | Exclude<WireStopReason, StopReason>
  | Exclude<StopReason, WireStopReason | 'stop_sequence'>
  | Exclude<WireRefusal, RefusalStopDetails['category']>
  | Exclude<NonNullable<RefusalStopDetails['category']>, WireRefusal>
  | Exclude<keyof WireUsage, keyof Usage>
  | Exclude<keyof NonNullable<WireUsage['cache_creation']>, keyof CacheCreation>
  | Exclude<
      keyof NonNullable<WireUsage['output_tokens_details']>,
      keyof OutputTokensDetails
    >
>;
