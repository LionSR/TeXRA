/**
 * The Gemini Interactions API as it arrives on the wire: the streamed events,
 * the interaction snapshot a GET returns, its steps and its usage, and their
 * decoding into canonical parts: a stream's events through `googleWire`, a
 * completed snapshot's steps through `snapshotParts`.
 */
import { Effect, Schema, SchemaGetter, Struct } from 'effect';

import { ModelError } from '../errors.js';
import { JsonObjectSchema } from '../protocol.js';
import { decodeWireOrFail, wireFail as fail } from './transport.js';
import type { Part, PartEvent } from './parts.js';

// SDK stream parsing does not validate the JSON values it returns.
const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const WireTextSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
});
/** One finished step of an interaction: a thought, model output or a call. */
const WireCompletedStepSchema = Schema.Union([
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
const WireSnapshotStepsSchema = WireTypedStepsSchema.pipe(
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
const WireUsageSchema = Schema.Struct({
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
const WireStreamInteractionSchema = WireInteractionSchema.mapFields(
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
const WireEventSchema = Schema.Union([
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

/** Open a canonical part; re-encode snapshot arguments until streamed deltas replace them. */
const stepPart = Effect.fn('llm.google.stepPart')(function* (
  step: typeof WireCompletedStepSchema.Type,
): Effect.fn.Return<Part, ModelError> {
  switch (step.type) {
    case 'thought':
      return {
        kind: 'reasoning',
        summary: (step.summary ?? []).map(({ text }) => ({
          kind: 'text',
          text,
        })),
        evidence:
          step.signature === undefined
            ? null
            : {
                kind: 'google-interactions-thought-signature',
                signature: step.signature,
              },
      };
    case 'model_output':
      if ((step.content?.length ?? 0) > 1)
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google returned unsupported assistant content.',
        });
      return {
        kind: 'message',
        content: (step.content ?? []).map(({ text }) => ({
          kind: 'text',
          text,
        })),
      };
    case 'function_call':
      return {
        kind: 'local-call',
        providerCallId: step.id,
        name: step.name,
        argumentsText:
          step.arguments === undefined ? '' : JSON.stringify(step.arguments),
      };
  }
});

/** A reported usage receipt; an absent one leaves the last in place. */
const usageParts = (
  usage: typeof WireUsageSchema.Type | undefined,
): PartEvent[] =>
  usage === undefined
    ? []
    : [
        {
          kind: 'usage',
          usage: {
            inputTokens: usage.total_input_tokens ?? null,
            outputTokens: usage.total_output_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
            cachedInputTokens: usage.total_cached_tokens ?? null,
            reasoningTokens: usage.total_thought_tokens ?? null,
            providerUsage: {
              kind: 'google',
              toolUsePromptTokens: usage.total_tool_use_tokens ?? null,
            },
          },
        },
      ];

/** A finished interaction's identity, usage and finish. */
const interactionEnd = (
  interaction: typeof WireStreamInteractionSchema.Type,
): PartEvent[] => [
  {
    kind: 'identity',
    id: interaction.id || null,
    model: interaction.model ?? null,
  },
  ...usageParts(interaction.usage),
  {
    kind: 'finish',
    finish: {
      finishReason:
        interaction.status === 'requires_action' ? 'tool-calls' : 'stop',
      // Google reports status but no terminal reason.
      finishEvidence: {
        kind: 'google-interactions',
        status: interaction.status,
        terminalReason: null,
      },
    },
  },
];

/** A step delta as the part it grows: text, summary, signature or arguments. */
function deltaPart(
  index: number,
  delta: Extract<
    typeof WireEventSchema.Type,
    { event_type: 'step.delta' }
  >['delta'],
): PartEvent {
  switch (delta.type) {
    case 'text':
      return { kind: 'append', index, channel: 'text', text: delta.text };
    case 'thought_summary':
      return {
        kind: 'append',
        index,
        channel: 'summary',
        text: delta.content.text,
      };
    case 'arguments_delta':
      return {
        kind: 'append',
        index,
        channel: 'arguments',
        text: delta.arguments,
      };
    case 'thought_signature':
      return {
        kind: 'evidence',
        index,
        evidence: {
          kind: 'google-interactions-thought-signature',
          signature: delta.signature,
        },
      };
  }
}

/**
 * One interaction's stream events as parts. Content arrives only through
 * complete step start/delta/stop cycles; `store` requires every event to
 * name its interaction.
 */
export function googleWire(
  store: boolean,
): (raw: unknown) => Effect.Effect<PartEvent[], ModelError> {
  let done = false;
  return (raw: unknown): Effect.Effect<PartEvent[], ModelError> =>
    Effect.gen(function* () {
      const event = yield* decodeWireOrFail(
        WireEventSchema,
        'Google returned malformed or unsupported stream data.',
        raw,
      );
      if (done)
        return yield* fail(
          'Google emitted data after its completed interaction.',
        );
      switch (event.event_type) {
        case 'interaction.created':
        case 'interaction.completed': {
          const interaction = event.interaction;
          if (store && !interaction.id)
            return yield* fail('Google omitted a stored interaction ID.');
          // The stream takes content only from complete start/delta/stop cycles.
          if (interaction.steps !== undefined)
            return yield* fail(
              'Google terminal step snapshots are not supported by this streaming codec.',
              'unsupported',
            );
          if (event.event_type === 'interaction.created')
            return [
              {
                kind: 'identity',
                id: interaction.id || null,
                model: interaction.model ?? null,
              },
              ...usageParts(interaction.usage),
            ];
          done = true;
          if (!COMPLETED_STATUSES.includes(event.interaction.status))
            return yield* fail(
              'Google ended without an authoritative completed turn.',
            );
          return interactionEnd(event.interaction);
        }
        case 'interaction.status_update':
          if (store && !event.interaction_id)
            return yield* fail('Google omitted a stored interaction ID.');
          return [
            { kind: 'identity', id: event.interaction_id || null, model: null },
          ];
        case 'error':
          return yield* new ModelError({
            kind: 'provider-rejection',
            message: 'Google reported a failed interaction.',
            cause: event,
          });
        case 'step.start':
          return [
            {
              kind: 'open',
              index: event.index,
              part: yield* stepPart(event.step),
            },
          ];
        case 'step.stop':
          return [
            ...usageParts(event.usage),
            { kind: 'close', index: event.index },
          ];
        case 'step.delta':
          return [
            ...usageParts(event.metadata?.total_usage),
            deltaPart(event.index, event.delta),
          ];
      }
    });
}

/**
 * A completed interaction snapshot as parts: its identity first, so a failing
 * step names the returned model, then each step opened and closed, then its
 * usage and finish.
 */
export const snapshotParts = (
  interaction: typeof WireInteractionSchema.Type,
): Effect.Effect<PartEvent[], ModelError> =>
  Effect.gen(function* () {
    const steps = yield* decodeWireOrFail(
      WireSnapshotStepsSchema,
      'Google returned malformed or unsupported completed steps.',
      interaction.steps,
    );
    const parts = yield* Effect.forEach(steps, (step, index) =>
      Effect.map(stepPart(step), (part): PartEvent[] => [
        { kind: 'open', index, part },
        { kind: 'close', index },
      ]),
    );
    const [identity, ...end] = interactionEnd(interaction);
    return [identity, ...parts.flat(), ...end];
  });
