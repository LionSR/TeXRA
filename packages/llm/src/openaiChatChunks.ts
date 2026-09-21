// Third-party imports
import { z } from 'zod';

// Local imports - canonical model contract
import { chatUsageCounts } from './chatStream.js';
import { ModelError } from './errors.js';
import { type ModelOrigin } from './protocol.js';
import {
  type ChatConfiguration,
  type ResolvedTurn,
  type TurnResult,
} from './turn.js';

export type ChatTurn = Extract<
  ResolvedTurn,
  { protocol: ChatConfiguration['protocol'] }
>;

export const UsageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
  // Documented provider receipts, not reconstructed token counts.
  cached_tokens: z.int().nonnegative().nullish(),
  prompt_cache_hit_tokens: z.int().nonnegative().nullish(),
  prompt_cache_miss_tokens: z.int().nonnegative().nullish(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
  completion_tokens_details: z
    .object({
      reasoning_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
});

export const TokenEstimateSchema = z.object({
  data: z.object({ total_tokens: z.int().nonnegative() }),
  error: z.never().optional(),
});

// Required content outside this protocol slice fails instead of being stripped.
export const ChunkSchema = z.strictObject({
  id: z.string().min(1),
  object: z.literal('chat.completion.chunk'),
  created: z.int(),
  model: z.string().min(1),
  system_fingerprint: z.string().nullish(),
  service_tier: z.string().nullish(),
  obfuscation: z.string().optional(),
  usage: UsageSchema.nullish(),
  choices: z
    .array(
      z.strictObject({
        index: z.literal(0),
        delta: z.strictObject({
          role: z.literal('assistant').optional(),
          content: z.string().nullish(),
          refusal: z.string().nullish(),
          tool_calls: z
            .array(
              z.strictObject({
                index: z.int().nonnegative(),
                id: z.string().min(1).nullish(),
                type: z.literal('function').nullish(),
                function: z
                  .strictObject({
                    name: z.string().min(1).nullish(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .nullish(),
        }),
        finish_reason: z
          .enum(['stop', 'length', 'content_filter', 'tool_calls'])
          .nullable(),
        logprobs: z.null().optional(),
      }),
    )
    .max(1),
});

export const ReasoningChunkSchema = ChunkSchema.extend({
  // Z.AI also reports its original request identity in the stream body.
  request_id: z.string().min(1).optional(),
  choices: z
    .array(
      ChunkSchema.shape.choices.element.extend({
        delta: ChunkSchema.shape.choices.element.shape.delta.extend({
          role: z.literal('assistant').nullish(),
          reasoning_content: z.string().nullish(),
        }),
        finish_reason: ChunkSchema.shape.choices.element.shape.finish_reason.or(
          z.literal('insufficient_system_resource'),
        ),
        usage: UsageSchema.nullish(),
      }),
    )
    .max(1),
});

export const XaiChunkSchema = ReasoningChunkSchema.extend({
  // xAI's intermediate deltas may omit finish_reason; final completion may not.
  choices: z
    .array(
      ReasoningChunkSchema.shape.choices.element.extend({
        finish_reason: ChunkSchema.shape.choices.element.shape.finish_reason
          .or(z.literal('end_turn'))
          .optional(),
      }),
    )
    .max(1),
  usage: UsageSchema.extend({
    cost_in_usd_ticks: z.int().nonnegative().nullish(),
  }).nullish(),
  service_tier: z.enum(['default', 'priority']).nullish(),
  // No hosted search or generated-file request is made by this protocol slice.
  citations: z.array(z.never()).nullish(),
  output_files: z.array(z.never()).nullish(),
});

export const DashscopeChunkSchema = ReasoningChunkSchema.extend({
  choices: z
    .array(
      ReasoningChunkSchema.shape.choices.element.extend({
        delta: ReasoningChunkSchema.shape.choices.element.shape.delta.extend({
          // The documented empty legacy field does not authorize legacy calls.
          function_call: z.null().optional(),
        }),
      }),
    )
    .max(1),
});

export const MiniMaxEnvelopeSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  base_resp: z
    .strictObject({
      status_code: z.int(),
      status_msg: z.string().optional(),
    })
    .optional(),
  input_sensitive: z.boolean().optional(),
  input_sensitive_type: z.int().optional(),
  output_sensitive: z.boolean().optional(),
  output_sensitive_type: z.int().optional(),
  output_sensitive_int: z.int().optional(),
});
// MiniMax documents partial receipts; no principal count is manufactured.
export const MiniMaxUsageSchema = z.strictObject({
  prompt_tokens: z.int().nonnegative().optional(),
  completion_tokens: z.int().nonnegative().optional(),
  total_tokens: z.int().nonnegative().optional(),
  total_characters: z.int().nonnegative().optional(),
  prompt_tokens_details: z
    .strictObject({ cached_tokens: z.int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .strictObject({ reasoning_tokens: z.int().nonnegative().optional() })
    .optional(),
});
export const MiniMaxReasoningDetailsSchema = z
  .array(
    z.strictObject({
      type: z.string().optional(),
      id: z.string().optional(),
      format: z.string().optional(),
      index: z.int().optional(),
      text: z.string().optional(),
    }),
  )
  .optional();
// MiniMax routes use the provider's delta grammar, never prefix guessing.
export const MiniMaxChunkSchema = ChunkSchema.extend({
  ...MiniMaxEnvelopeSchema.omit({ id: true, model: true }).shape,
  usage: MiniMaxUsageSchema.optional().nullable(),
  choices: z
    .array(
      ChunkSchema.shape.choices.element.extend({
        delta: ReasoningChunkSchema.shape.choices.element.shape.delta.extend({
          name: z.string().optional(),
          audio_content: z.literal('').optional(),
          reasoning_details: MiniMaxReasoningDetailsSchema,
        }),
      }),
    )
    .max(1),
});

/** Retain provider observations without interpreting detection as filtering. */
export const miniMaxDetection = (
  envelope: z.infer<typeof MiniMaxEnvelopeSchema>,
) => ({
  ...(envelope.input_sensitive !== undefined
    ? { inputSensitive: envelope.input_sensitive }
    : {}),
  ...(envelope.input_sensitive_type !== undefined
    ? { inputSensitiveType: envelope.input_sensitive_type }
    : {}),
  ...(envelope.output_sensitive !== undefined
    ? { outputSensitive: envelope.output_sensitive }
    : {}),
  ...(envelope.output_sensitive_type !== undefined
    ? { outputSensitiveType: envelope.output_sensitive_type }
    : {}),
  ...(envelope.output_sensitive_int !== undefined
    ? { outputSensitiveInt: envelope.output_sensitive_int }
    : {}),
});

/** HTTP success does not override MiniMax's embedded failure receipt. */
export const miniMaxFailure = (
  envelope: z.infer<typeof MiniMaxEnvelopeSchema>,
  origin: Exclude<ModelOrigin, { protocol: 'vscode-lm' }>,
  httpStatus: number,
  cause: unknown,
  detection = miniMaxDetection(envelope),
): ModelError | undefined => {
  const status = envelope.base_resp;
  if (status === undefined || status.status_code === 0) return undefined;
  return new ModelError({
    kind:
      status.status_code === 1004 || status.status_code === 2049
        ? 'authentication'
        : 'provider-rejection',
    message: status.status_msg ?? 'MiniMax rejected the completion request.',
    status: httpStatus,
    responseId: envelope.id === '' ? undefined : envelope.id,
    model: envelope.model === '' ? undefined : envelope.model,
    providerEvidence: Object.freeze({
      kind: 'minimax',
      origin: Object.freeze({ ...origin, protocol: 'minimax-chat' }),
      statusCode: status.status_code,
      ...(status.status_msg !== undefined
        ? { statusMessage: status.status_msg }
        : {}),
      ...detection,
    }),
    cause,
  });
};

export const miniMaxUsage = (
  receipt: z.infer<typeof MiniMaxUsageSchema> | undefined,
): TurnResult['usage'] =>
  receipt === undefined
    ? null
    : {
        ...chatUsageCounts(receipt),
        ...(receipt.total_characters !== undefined
          ? {
              providerUsage: {
                kind: 'minimax',
                totalCharacters: receipt.total_characters,
              },
            }
          : {}),
      };

export type MiniMaxReasoning = Extract<
  Extract<TurnResult['content'][number], { kind: 'reasoning' }>['evidence'],
  { kind: 'minimax-reasoning' }
>;
