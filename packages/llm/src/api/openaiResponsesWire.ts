/**
 * The OpenAI Responses API as it arrives on the wire: the response snapshot
 * and its output items, the event envelopes a stream carries them in, and
 * the frames of the WebSocket transport. The socket frames are wire shapes
 * too: the same Responses events travel inside them, with an envelope that
 * names the lane and an error frame that carries no HTTP status.
 * `openaiResponsesCodec.ts` decodes these into canonical parts. The Files
 * API's create response is here too: `decodeUploadedFile` reads it.
 */
import { Effect, Schema, SchemaGetter, Struct } from 'effect';

import { ModelError, authOrRejectionKind } from '../errors.js';
import { decodeWireOrFail } from './transport.js';

import { ResponsesUsageSchema } from './openaiResponsesUsage.js';
import { UploadedSchema } from './uploadCache.js';

const ItemStatusSchema = Schema.Literals([
  'in_progress',
  'completed',
  'incomplete',
]);
const ReasoningTextSchema = Schema.Struct({
  type: Schema.Literal('reasoning_text'),
  text: Schema.String,
});
const OutputItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('message'),
    id: Schema.String.check(Schema.isMinLength(1)),
    role: Schema.Literal('assistant'),
    status: ItemStatusSchema,
    phase: Schema.optional(
      Schema.NullOr(Schema.Literals(['commentary', 'final_answer'])),
    ),
    content: Schema.Array(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal('output_text'),
          text: Schema.String,
          // Unsupported annotations/log probabilities cannot disappear in
          // conversion; Zhipu omits the empty annotation list.
          annotations: Schema.optional(Schema.Array(Schema.Never)),
          logprobs: Schema.optional(Schema.NullOr(Schema.Array(Schema.Never))),
        }),
        Schema.Struct({
          type: Schema.Literal('refusal'),
          refusal: Schema.String,
        }),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('reasoning'),
    id: Schema.String.check(Schema.isMinLength(1)),
    status: Schema.optional(ItemStatusSchema),
    encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
    // Zhipu reports no summary and one reasoning-text object, not a list.
    summary: Schema.Array(
      Schema.Struct({
        type: Schema.Literal('summary_text'),
        text: Schema.String,
      }),
    ).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
    content: Schema.optional(
      Schema.Union([
        Schema.Array(ReasoningTextSchema),
        ReasoningTextSchema.pipe(
          Schema.decodeTo(Schema.Array(ReasoningTextSchema), {
            decode: SchemaGetter.transform((part) => [part]),
            encode: SchemaGetter.forbidden(() => 'decode-only'),
          }),
        ),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('function_call'),
    id: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    status: Schema.optional(ItemStatusSchema),
    call_id: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.String.check(Schema.isMinLength(1)),
    arguments: Schema.String,
  }),
]);
/** One decoded output item. */
export type OutputItem = typeof OutputItemSchema.Type;

/** A response snapshot: identity, status, output items and usage. */
export const ResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  object: Schema.Literal('response'),
  model: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.Literals([
    'queued',
    'in_progress',
    'completed',
    'failed',
    'cancelled',
    'incomplete',
  ]),
  output: Schema.Array(OutputItemSchema),
  usage: Schema.optional(Schema.NullOr(ResponsesUsageSchema)),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ),
  ),
  incomplete_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.Literals(['max_output_tokens', 'content_filter']),
      }),
    ),
  ),
});
/** One decoded response snapshot. */
export type ResponseValue = typeof ResponseSchema.Type;

/** What every streamed event carries: its type and sequence number. */
export const EventSchema = Schema.Struct({
  type: Schema.String,
  sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** An event carrying the whole response snapshot. */
export const ResponseEventSchema = EventSchema.mapFields(
  Struct.assign({
    response: ResponseSchema,
  }),
);
/** An event carrying one output item. */
export const ItemEventSchema = EventSchema.mapFields(
  Struct.assign({
    output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    item: OutputItemSchema,
  }),
);
/** An event carrying a text delta for one item's content. */
export const DeltaEventSchema = EventSchema.mapFields(
  Struct.assign({
    item_id: Schema.String.check(Schema.isMinLength(1)),
    output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    delta: Schema.String,
    logprobs: Schema.optional(Schema.NullOr(Schema.Array(Schema.Never))),
  }),
);

/** What every socket frame carries: its event type and lane. */
const WebSocketEnvelopeSchema = Schema.Struct({
  type: Schema.String,
  // This acquisition owns the implicit lane, not a multiplexed connection.
  stream_id: Schema.optional(Schema.Never),
});
// An error event in the stream's own sequence, with no HTTP status.
const SequencedWebSocketErrorSchema = Schema.Struct({
  type: Schema.Literal('error'),
  sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  param: Schema.NullOr(Schema.String),
});
/** An error frame, with or without an HTTP status, read as one shape. */
const WebSocketErrorSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('error'),
    status: Schema.optional(Schema.Int),
    error: Schema.Struct({
      type: Schema.String,
      code: Schema.NullOr(Schema.String),
      message: Schema.String,
      param: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  SequencedWebSocketErrorSchema.pipe(
    Schema.decodeTo(
      Schema.Struct({
        error: SequencedWebSocketErrorSchema,
        status: Schema.Undefined,
      }),
      {
        decode: SchemaGetter.transform((error) => ({
          error,
          status: undefined,
        })),
        encode: SchemaGetter.transform(({ error }) => error),
      },
    ),
  ),
]);

/**
 * What a Files API upload must return before its id is cached. The SDK's
 * type is not a check on the JSON, so a missing or empty id, or an expiry
 * that is not whole non-negative Unix seconds (absent means the file does
 * not expire), is a malformed response: the upload counts as failed and the
 * bytes are sent.
 */
const UploadedFileSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  expires_at: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
}).pipe(
  Schema.decodeTo(UploadedSchema, {
    decode: SchemaGetter.transform((file) => ({
      fileId: file.id,
      expiresAtMs: file.expires_at == null ? null : file.expires_at * 1000,
    })),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);
/** Reads a Files API create response into the upload cache's canonical form. */
export const decodeUploadedFile =
  Schema.decodeUnknownResult(UploadedFileSchema);

const JsonFrameSchema = Schema.fromJsonString(Schema.Unknown);
/**
 * One WebSocket frame as the Responses event it carries. A binary frame, bad
 * JSON or a multiplexed lane is malformed; an error frame fails with the
 * provider's rejection.
 */
export const socketFrameEvent = (
  frame: unknown,
): Effect.Effect<unknown, ModelError> =>
  Effect.gen(function* () {
    if (typeof frame !== 'string')
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'The Responses connection returned a binary frame.',
      });
    const raw = yield* decodeWireOrFail(
      JsonFrameSchema,
      'The Responses connection returned invalid JSON.',
      frame,
    );
    const envelope = yield* decodeWireOrFail(
      WebSocketEnvelopeSchema,
      'The Responses event does not belong to the implicit lane.',
      raw,
    );
    if (envelope.type !== 'error') return raw;
    const rejected = yield* decodeWireOrFail(
      WebSocketErrorSchema,
      'The Responses connection returned a malformed error.',
      raw,
    );
    return yield* new ModelError({
      kind: authOrRejectionKind(rejected.status),
      message: rejected.error.message,
      status: rejected.status,
      cause: rejected.error,
    });
  });
