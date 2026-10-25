/**
 * The Anthropic Messages API as it arrives on the wire: the streamed events,
 * their content blocks, the usage and the stop facts. `anthropicMessages.ts`
 * decodes these into canonical parts.
 */
import { Schema, Struct } from 'effect';

import { JsonObjectSchema } from '../protocol.js';

const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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
        'stop_sequence',
        'tool_use',
        'pause_turn',
        'refusal',
        'model_context_window_exceeded',
      ]),
    ),
  ),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
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
    id: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.String.check(Schema.isMinLength(1)),
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
        id: Schema.String.check(Schema.isMinLength(1)),
        model: Schema.String.check(Schema.isMinLength(1)),
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
