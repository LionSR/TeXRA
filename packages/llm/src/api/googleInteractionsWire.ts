/**
 * The Gemini Interactions API as it arrives on the wire: the streamed events,
 * the interaction snapshot a GET returns, its steps and its usage.
 * `googleInteractions.ts` decodes these into canonical parts.
 */
import type { Interactions } from '@google/genai';
import { Schema, SchemaGetter, Struct } from 'effect';

import { CountSchema, JsonObjectSchema } from '../protocol.js';

// SDK stream parsing does not validate the JSON values it returns.
const WireTextSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
});
/** One finished step of an interaction: a thought, model output or a call. */
export const WireCompletedStepSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('thought'),
    summary: Schema.optional(Schema.Array(WireTextSchema)),
    signature: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal('model_output'),
    content: Schema.optional(Schema.Array(WireTextSchema)),
  }),
  Schema.Struct({
    type: Schema.Literal('function_call'),
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    arguments: Schema.optional(JsonObjectSchema),
    // A replay needs only the thought's signature, so a call's is not kept.
    signature: Schema.optional(Schema.NonEmptyString),
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
  id: Schema.NonEmptyString,
  status: Schema.String,
  model: Schema.optional(Schema.NonEmptyString),
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
/**
 * The interaction statuses the SDK names. Its type also admits any string,
 * dropped here so a misspelled status fails to compile.
 */
type InteractionStatus<S = Interactions.Interaction['status']> =
  S extends string ? (string extends S ? never : S) : never;
/** The statuses of an interaction still running. */
export const IN_FLIGHT_STATUSES: readonly string[] = Object.freeze([
  'queued',
  'in_progress',
] satisfies InteractionStatus[]);
/** The statuses of an interaction that produced its output. */
export const COMPLETED_STATUSES: readonly string[] = Object.freeze([
  'completed',
  'requires_action',
] satisfies InteractionStatus[]);
/** The status of an interaction stopped at its per-request decode limit. */
export const CONTINUATION_STATUS: string =
  'requires_continuation' satisfies InteractionStatus;
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
    // The interaction's running total, which replaces the last receipt;
    // `step_usage` counts this step alone.
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
        signature: Schema.NonEmptyString,
      }),
      Schema.Struct({
        type: Schema.Literal('arguments_delta'),
        arguments: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({ event_type: Schema.Literal('error'), error: Schema.Unknown }),
]);

type Assignable<T extends U, U> = T;
// The schemas that restate an SDK shape decode into it, so an SDK release
// that renames or retypes one of these fields fails to compile. The others
// differ on purpose: a stateless stream's events carry no id, the created
// event no status, and the step schemas take only the steps this codec
// decodes, as readonly arrays.
type _UsageIsTheSdks = Assignable<
  typeof WireUsageSchema.Type,
  Interactions.Usage
>;
type _StepEventsAreTheSdks = Assignable<
  Extract<
    typeof WireEventSchema.Type,
    { event_type: 'step.stop' | 'step.delta' }
  >,
  Interactions.InteractionSSEEvent
>;
