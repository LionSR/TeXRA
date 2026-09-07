// Third-party imports
import { Data, type Effect, type Stream } from 'effect';
import { z } from 'zod';

const TextPartSchema = z
  .strictObject({ kind: z.literal('text'), text: z.string() })
  .readonly();
const MediaFieldsSchema = z.strictObject({
  mimeType: z.string().min(1),
  // Encoding validity is distinct from a provider accepting the captured bytes.
  base64: z.base64(),
});
const InputPartSchema = z.discriminatedUnion('kind', [
  TextPartSchema,
  MediaFieldsSchema.extend({
    kind: z.literal('image'),
    detail: z.enum(['low', 'medium', 'high', 'ultra-high']).optional(),
  }).readonly(),
  MediaFieldsSchema.extend({
    kind: z.enum(['audio', 'video', 'document']),
  }).readonly(),
]);
const BindingSchema = z.strictObject({
  requestedModel: z.string().min(1),
  deployment: z
    .strictObject({ endpoint: z.url(), credentialScope: z.string().min(1) })
    .readonly(),
});
const OriginSchema = BindingSchema.extend({
  protocol: z.enum(['openai-chat', 'google-interactions', 'openai-responses']),
  codecVersion: z.literal(1),
});

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = OriginSchema.readonly();
export type ModelOrigin = z.infer<typeof ModelOriginSchema>;

/** Compares the complete non-secret binding, not runtime lineage. */
export function sameModelOrigin(
  left: ModelOrigin,
  right: ModelOrigin,
): boolean {
  return (
    left.protocol === right.protocol &&
    left.codecVersion === right.codecVersion &&
    left.requestedModel === right.requestedModel &&
    left.deployment.endpoint === right.deployment.endpoint &&
    left.deployment.credentialScope === right.deployment.credentialScope
  );
}

function freezeJson(value: z.infer<ReturnType<typeof z.json>>): typeof value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

function hasSupportedJsonKeys(
  value: unknown,
  parents = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (parents.has(value) || Object.hasOwn(value, '__proto__')) return false;
  parents.add(value);
  const valid = Object.values(value).every((nested) =>
    hasSupportedJsonKeys(nested, parents),
  );
  parents.delete(value);
  return valid;
}

/** Materialized JSON, including immutable nested containers. */
export const JsonObjectSchema = z
  .unknown()
  .refine(hasSupportedJsonKeys, {
    message:
      'JSON cannot contain cycles or __proto__ keys, which this codec cannot preserve.',
  })
  .pipe(z.record(z.string(), z.json().transform(freezeJson)).readonly());

const OutputPartSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('message'),
      content: z
        .array(
          z.discriminatedUnion('kind', [
            TextPartSchema,
            z
              .strictObject({ kind: z.literal('refusal'), text: z.string() })
              .readonly(),
          ]),
        )
        .readonly(),
      evidence: z
        .strictObject({
          kind: z.literal('openai-responses-message'),
          itemId: z.string().min(1),
          status: z.enum(['completed', 'incomplete']),
          phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
        })
        .readonly()
        .optional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('reasoning'),
      summary: z.array(TextPartSchema).readonly(),
      content: z.array(TextPartSchema).readonly().optional(),
      evidence: z
        .discriminatedUnion('kind', [
          z
            .strictObject({
              kind: z.literal('google-interactions-thought-signature'),
              signature: z.string().min(1),
            })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('openai-responses-reasoning'),
              itemId: z.string().min(1),
              // Missing, null and exact opaque bytes have distinct wire meanings.
              encryptedContent: z.string().nullable().optional(),
              status: z.enum(['completed', 'incomplete']).optional(),
            })
            .readonly(),
        ])
        .nullable(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('local-call'),
      providerCallId: z.string().min(1).nullable(),
      name: z.string().min(1),
      arguments: JsonObjectSchema,
      evidence: z
        .strictObject({
          kind: z.literal('openai-responses-function-call'),
          itemId: z.string().min(1).optional(),
          status: z.literal('completed').optional(),
        })
        .readonly()
        .optional(),
    })
    .readonly(),
]);

const ContentSchema = z.array(OutputPartSchema).readonly();

function validateAssistantContent(
  origin: ModelOrigin,
  content: z.infer<typeof ContentSchema>,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, part] of content.entries()) {
    const evidence = part.evidence;
    if (
      evidence != null &&
      origin.protocol !==
        (evidence.kind === 'google-interactions-thought-signature'
          ? 'google-interactions'
          : 'openai-responses')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Provider content evidence requires its original protocol binding.',
      });
    }
    if (
      evidence != null &&
      'itemId' in evidence &&
      evidence.itemId !== undefined
    ) {
      if (itemIds.has(evidence.itemId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['content', index, 'evidence', 'itemId'],
          message: 'Provider item IDs must be distinct within one response.',
        });
      }
      itemIds.add(evidence.itemId);
    }
    if (part.kind !== 'local-call' || part.providerCallId === null) continue;
    if (ids.has(part.providerCallId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index, 'providerCallId'],
        message: 'Provider call IDs must be distinct within one response.',
      });
    }
    ids.add(part.providerCallId);
  }
}

const AssistantMessageSchema = z
  .strictObject({
    role: z.literal('assistant'),
    origin: ModelOriginSchema,
    content: ContentSchema,
  })
  .superRefine((message, ctx) =>
    validateAssistantContent(message.origin, message.content, ctx),
  )
  .readonly();

const MessageSchema = z.discriminatedUnion('role', [
  z
    .strictObject({
      role: z.literal('user'),
      content: z.array(InputPartSchema).min(1).readonly(),
    })
    .readonly(),
  AssistantMessageSchema,
  z
    .strictObject({
      role: z.literal('tool'),
      results: z
        .array(
          z
            .strictObject({
              callOrdinal: z.int().nonnegative(),
              status: z.enum(['success', 'error']),
              content: z.array(InputPartSchema).readonly(),
            })
            .readonly(),
        )
        .min(1)
        .readonly(),
    })
    .readonly(),
]);

// A completed assistant can precede settlement; only the next request requires it.
const PreparedHistorySchema = z
  .array(MessageSchema)
  .min(1)
  .superRefine((messages, ctx) => {
    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant') {
        const calls = message.content.filter(
          (part) => part.kind === 'local-call',
        );
        if (calls.length === 0) continue;
        const results = messages[index + 1];
        if (
          results?.role !== 'tool' ||
          results.results.length !== calls.length ||
          !results.results.every(
            (result, ordinal) => result.callOrdinal === ordinal,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message:
              'Every local call requires one adjacent, complete, ordinal-ordered tool-result group before another generation.',
          });
        }
      } else if (message.role === 'tool') {
        const previous = messages[index - 1];
        if (
          previous?.role !== 'assistant' ||
          !previous.content.some((part) => part.kind === 'local-call')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message:
              'Tool results require an immediately preceding calling assistant.',
          });
        }
      }
    }
  })
  .readonly();

const ToolDefinitionSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string(),
    parameters: JsonObjectSchema,
  })
  .readonly();
const ToolDefinitionsSchema = z
  .array(ToolDefinitionSchema)
  .superRefine((tools, ctx) => {
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Tool definitions must have distinct names.',
      });
    }
  })
  .readonly();

/** Provider acceleration of an exact prefix, never the conversation authority. */
export const ContinuationSchema = z
  .strictObject({
    origin: OriginSchema.extend({
      protocol: z.literal('google-interactions'),
    }).readonly(),
    coveredMessages: z.int().positive(),
    prefixFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    anchor: z
      .strictObject({
        interactionId: z.string().min(1),
        coveredSteps: z.int().positive(),
      })
      .readonly(),
  })
  .readonly();
export type Continuation = z.infer<typeof ContinuationSchema>;

const ToolChoiceSchema = z.union([
  z.literal('auto'),
  z.strictObject({ name: z.string().min(1) }).readonly(),
]);
const ResponsesReasoningSchema = z
  .strictObject({
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .nullable(),
    mode: z.enum(['standard', 'pro']).nullable(),
    summary: z.enum(['auto', 'concise', 'detailed']).nullable(),
  })
  .readonly()
  .nullable();

/** Materialized input; no SDK value, credential, file path or storage reference. */
export const TurnRequestSchema = z
  .strictObject({
    system: z.string().optional(),
    messages: PreparedHistorySchema,
    tools: ToolDefinitionsSchema.optional(),
    parallelToolCalls: z.boolean().optional(),
    toolChoice: ToolChoiceSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.int().positive().optional(),
    store: z.boolean().optional(),
    thinkingLevel: z.enum(['low', 'medium', 'high']).optional(),
    reasoning: ResponsesReasoningSchema.optional(),
    serviceTier: z.literal('fast').nullable().optional(),
    continuation: ContinuationSchema.optional(),
  })
  .readonly();
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

const OpenAIControlsSchema = z.strictObject({
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.int().positive(),
  parallelToolCalls: z.boolean(),
  toolChoice: ToolChoiceSchema,
});
const GoogleControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  store: z.boolean(),
  thinkingLevel: z.enum(['low', 'medium', 'high']),
  toolChoice: ToolChoiceSchema,
});
const ResponsesControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  temperature: z.number().min(0).max(2).nullable(),
  store: z.boolean(),
  parallelToolCalls: z.boolean(),
  toolChoice: ToolChoiceSchema,
  reasoning: ResponsesReasoningSchema,
  serviceTier: z.literal('fast').nullable(),
});

/** Already-selected protocol binding and defaults, provided by the application. */
export const ModelConfigurationSchema = z.discriminatedUnion('protocol', [
  BindingSchema.extend({
    protocol: z.literal('openai-chat'),
    defaults: OpenAIControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('google-interactions'),
    defaults: GoogleControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('openai-responses'),
    supportsTemperature: z.boolean(),
    defaults: ResponsesControlsSchema.omit({ toolChoice: true }).readonly(),
  })
    .superRefine((configuration, ctx) => {
      if (
        !configuration.supportsTemperature &&
        configuration.defaults.temperature !== null
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaults', 'temperature'],
          message:
            'A protocol without temperature support requires a null default.',
        });
      }
    })
    .readonly(),
]);
export type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>;
export type OpenAIChatConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'openai-chat' }
>;
export type GoogleInteractionsConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'google-interactions' }
>;
export type OpenAIResponsesConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'openai-responses' }
>;

const PreparedInputSchema = OriginSchema.extend({
  mode: z.literal('foreground'),
  system: z.string().optional(),
  messages: PreparedHistorySchema,
  tools: ToolDefinitionsSchema,
});
/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = z.discriminatedUnion('protocol', [
  PreparedInputSchema.extend({
    protocol: z.literal('openai-chat'),
    controls: OpenAIControlsSchema.readonly(),
  }).readonly(),
  PreparedInputSchema.extend({
    protocol: z.literal('google-interactions'),
    controls: GoogleControlsSchema.readonly(),
    continuation: ContinuationSchema.optional(),
  }).readonly(),
  PreparedInputSchema.extend({
    protocol: z.literal('openai-responses'),
    controls: ResponsesControlsSchema.readonly(),
  }).readonly(),
]);
export type ResolvedTurn = z.infer<typeof ResolvedTurnSchema>;

const UsageSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
    cachedInputTokens: z.int().nonnegative().nullable(),
    reasoningTokens: z.int().nonnegative().nullable(),
  })
  .readonly();

/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = z
  .strictObject({
    providerResponseId: z.string().min(1),
    requestedOrigin: ModelOriginSchema,
    returnedModel: z.string().min(1).nullable(),
    modelFingerprint: z.string().nullable(),
    content: ContentSchema,
    finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls']),
    /** Unknown counts remain unknown, including within a partial receipt. */
    usage: UsageSchema.nullable(),
    continuation: ContinuationSchema.optional(),
  })
  .superRefine((result, ctx) => {
    validateAssistantContent(result.requestedOrigin, result.content, ctx);
    if (
      result.finishReason !== 'length' &&
      result.finishReason !== 'content-filter' &&
      result.content.some(
        (part) =>
          part.evidence != null &&
          'status' in part.evidence &&
          part.evidence.status === 'incomplete',
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message:
          'Incomplete provider items require an incomplete turn outcome.',
      });
    }
    if (
      result.continuation &&
      !sameModelOrigin(result.requestedOrigin, result.continuation.origin)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['continuation'],
        message: 'Continuation belongs to another model origin.',
      });
    }
  })
  .readonly();
export type TurnResult = z.infer<typeof TurnResultSchema>;

const TurnEventSchema = z.discriminatedUnion('kind', [
  // Foreground identity evidence is neither background acceptance nor cancellation.
  z
    .strictObject({
      kind: z.literal('identified'),
      providerResponseId: z.string().min(1),
      requestedOrigin: ModelOriginSchema,
      returnedModel: z.string().min(1).nullable(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('delta'),
      part: z.enum(['text', 'refusal', 'reasoning']),
      text: z.string(),
    })
    .readonly(),
  z
    .strictObject({ kind: z.literal('completed'), result: TurnResultSchema })
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
