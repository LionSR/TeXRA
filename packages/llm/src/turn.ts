// Third-party imports
import { Data, type Effect, type Stream } from 'effect';
import { z } from 'zod';

/** The currently implemented content vocabulary rejects unsupported parts. */
const TextPartSchema = z
  .strictObject({
    kind: z.literal('text'),
    text: z.string(),
  })
  .readonly();

const InputMessageSchema = z
  .strictObject({
    role: z.enum(['user', 'assistant']),
    content: z.array(TextPartSchema).min(1).readonly(),
  })
  .readonly();

/** Materialized input; no SDK value, credential, file path or storage reference. */
export const TurnRequestSchema = z
  .strictObject({
    system: z.string().optional(),
    messages: z.array(InputMessageSchema).min(1).readonly(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.int().positive().optional(),
  })
  .readonly();

export type TurnRequest = z.infer<typeof TurnRequestSchema>;

const ControlsSchema = z
  .strictObject({
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.int().positive(),
  })
  .readonly();

const DeploymentSchema = z
  .strictObject({
    endpoint: z.url(),
    credentialScope: z.string().min(1),
  })
  .readonly();

/** Already-selected binding and defaults, provided by the application. */
export const ModelConfigurationSchema = z
  .strictObject({
    model: z.string().min(1),
    deployment: DeploymentSchema,
    defaults: ControlsSchema,
  })
  .readonly();

export type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>;

/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = z
  .strictObject({
    protocol: z.literal('openai-chat'),
    codecVersion: z.literal(1),
    mode: z.literal('foreground'),
    model: z.string().min(1),
    deployment: DeploymentSchema,
    system: z.string().optional(),
    messages: z.array(InputMessageSchema).min(1).readonly(),
    controls: ControlsSchema,
  })
  .readonly();

export type ResolvedTurn = z.infer<typeof ResolvedTurnSchema>;

const UsageSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    totalTokens: z.int().nonnegative(),
    cachedInputTokens: z.int().nonnegative().nullable(),
    reasoningTokens: z.int().nonnegative().nullable(),
  })
  .readonly();

const OutputPartSchema = z.discriminatedUnion('kind', [
  TextPartSchema,
  z.strictObject({ kind: z.literal('refusal'), text: z.string() }).readonly(),
]);

/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = z
  .strictObject({
    responseId: z.string().min(1),
    model: z.string().min(1),
    modelFingerprint: z.string().nullable(),
    content: z.array(OutputPartSchema).readonly(),
    finishReason: z.enum(['stop', 'length', 'content-filter']),
    /** No reported receipt is unknown, never an invented zero-usage receipt. */
    usage: UsageSchema.nullable(),
  })
  .readonly();

export type TurnResult = z.infer<typeof TurnResultSchema>;

const TurnEventSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('delta'),
      part: z.enum(['text', 'refusal']),
      text: z.string(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('completed'),
      result: TurnResultSchema,
    })
    .readonly(),
]);

export type TurnEvent = z.infer<typeof TurnEventSchema>;

const ModelErrorFieldsSchema = z.strictObject({
  kind: z.enum([
    'invalid-request',
    'unsupported',
    'authentication',
    'transport',
    'provider-rejection',
    'malformed-output',
  ]),
  message: z.string(),
  requestId: z.string().optional(),
  responseId: z.string().optional(),
  model: z.string().optional(),
  status: z.int().optional(),
});

/** Typed provider failure. Fiber interruption remains outside this channel. */
export class ModelError extends Data.TaggedError('ModelError')<
  z.infer<typeof ModelErrorFieldsSchema> & { readonly cause?: unknown }
> {}

/** A configured executable value; it owns neither conversation nor retry policy. */
export interface Model {
  prepareTurn(request: TurnRequest): Effect.Effect<ResolvedTurn, ModelError>;
  streamTurn(turn: ResolvedTurn): Stream.Stream<TurnEvent, ModelError>;
  generateTurn(turn: ResolvedTurn): Effect.Effect<TurnResult, ModelError>;
}
