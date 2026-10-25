/**
 * The Gemini Interactions API as it arrives on the wire: the streamed events,
 * the interaction snapshot a GET returns, its steps and its usage.
 * `googleInteractions.ts` decodes these into canonical parts.
 */
import { Schema, SchemaGetter, Struct } from 'effect';

import { JsonObjectSchema } from '../protocol.js';

// SDK stream parsing does not validate the JSON values it returns.
const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const WireTextSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
});
/** One finished step of an interaction: a thought, model output or a call. */
export const WireCompletedStepSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('thought'),
    summary: Schema.optional(Schema.Array(WireTextSchema)),
    signature: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
  Schema.Struct({
    type: Schema.Literal('model_output'),
    content: Schema.optional(Schema.Array(WireTextSchema)),
  }),
  Schema.Struct({
    type: Schema.Literal('function_call'),
    id: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.String.check(Schema.isMinLength(1)),
    arguments: Schema.optional(JsonObjectSchema),
    // A replay needs only the thought's signature, so a call's is not kept.
    signature: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
]);
// A GET echoes the input ahead of the output whatever `include_input` says,
// and output holds no user input or function result, so those end the echo.
const isInputEcho = ({ type }: { type: string }) =>
  type === 'user_input' || type === 'function_result';
const WireTypedStepsSchema = Schema.Array(
  Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);
/** A GET's steps after the echoed input, as completed steps. */
export const WireSnapshotStepsSchema = WireTypedStepsSchema.pipe(
  Schema.decodeTo(WireTypedStepsSchema, {
    decode: SchemaGetter.transform((steps) =>
      steps.slice(steps.findLastIndex(isInputEcho) + 1),
    ),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
  Schema.decodeTo(Schema.Array(WireCompletedStepSchema)),
);
// A stream start announces a call; its arguments arrive in subsequent deltas.
const WireStepSchema = WireCompletedStepSchema.check(
  Schema.makeFilter(
    (step) =>
      step.type !== 'function_call' ||
      step.arguments === undefined ||
      Object.keys(step.arguments).length === 0,
  ),
);
/** An interaction's token counts as Google reports them. */
export const WireUsageSchema = Schema.Struct({
  total_input_tokens: Schema.optional(CountSchema),
  total_output_tokens: Schema.optional(CountSchema),
  total_tokens: Schema.optional(CountSchema),
  total_cached_tokens: Schema.optional(CountSchema),
  total_thought_tokens: Schema.optional(CountSchema),
  total_tool_use_tokens: Schema.optional(CountSchema),
});
/** The interaction a GET or a background create returns. */
export const WireInteractionSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.String,
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  steps: Schema.optional(Schema.Unknown),
  usage: Schema.optional(WireUsageSchema),
});
// Stateless streams can report no retrievable interaction ID.
/** The interaction as a stream event carries it; a stateless stream has no id. */
export const WireStreamInteractionSchema = WireInteractionSchema.mapFields(
  Struct.assign({
    id: Schema.optional(Schema.String),
  }),
);
/** The statuses of an interaction still running. */
export const IN_FLIGHT_STATUSES: readonly string[] = ['queued', 'in_progress'];
/** The statuses of an interaction that produced its output. */
export const COMPLETED_STATUSES: readonly string[] = [
  'completed',
  'requires_action',
];
/** One event of a streamed interaction. */
export const WireEventSchema = Schema.Union([
  Schema.Struct({
    event_type: Schema.Literal('interaction.created'),
    interaction: WireStreamInteractionSchema.mapFields(Struct.omit(['status'])),
  }),
  Schema.Struct({
    event_type: Schema.Literal('interaction.completed'),
    interaction: WireStreamInteractionSchema,
  }),
  Schema.Struct({
    event_type: Schema.Literal('interaction.status_update'),
    interaction_id: WireStreamInteractionSchema.fields.id,
    status: Schema.String,
  }),
  Schema.Struct({
    event_type: Schema.Literal('step.start'),
    index: CountSchema,
    step: WireStepSchema,
  }),
  Schema.Struct({
    event_type: Schema.Literal('step.stop'),
    index: CountSchema,
    usage: Schema.optional(WireUsageSchema),
  }),
  Schema.Struct({
    event_type: Schema.Literal('step.delta'),
    index: CountSchema,
    metadata: Schema.optional(
      Schema.Struct({ total_usage: Schema.optional(WireUsageSchema) }),
    ),
    delta: Schema.Union([
      Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal('thought_summary'),
        content: WireTextSchema,
      }),
      Schema.Struct({
        type: Schema.Literal('thought_signature'),
        signature: Schema.String.check(Schema.isMinLength(1)),
      }),
      Schema.Struct({
        type: Schema.Literal('arguments_delta'),
        arguments: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({ event_type: Schema.Literal('error'), error: Schema.Unknown }),
]);
