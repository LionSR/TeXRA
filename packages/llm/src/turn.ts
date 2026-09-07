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
  protocol: z.enum([
    'openai-chat',
    'google-interactions',
    'openai-responses',
    'anthropic-messages',
    'deepseek-chat',
    'kimi-chat',
    'glm-chat',
  ]),
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
            .strictObject({ kind: z.literal('chat-reasoning-content') })
            .readonly(),
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
          z
            .strictObject({
              kind: z.literal('anthropic-thinking-signature'),
              signature: z.string(),
            })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('anthropic-redacted-thinking'),
              data: z.string(),
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
const EVIDENCE_PROTOCOL = {
  'google-interactions-thought-signature': 'google-interactions',
  'openai-responses-message': 'openai-responses',
  'openai-responses-reasoning': 'openai-responses',
  'openai-responses-function-call': 'openai-responses',
  'anthropic-thinking-signature': 'anthropic-messages',
  'anthropic-redacted-thinking': 'anthropic-messages',
} as const;

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
      (evidence.kind === 'chat-reasoning-content'
        ? !['deepseek-chat', 'kimi-chat', 'glm-chat'].includes(origin.protocol)
        : origin.protocol !== EVIDENCE_PROTOCOL[evidence.kind])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Provider content evidence requires its original protocol binding.',
      });
    }
    if (
      part.kind === 'reasoning' &&
      (((evidence?.kind === 'anthropic-thinking-signature' ||
        evidence?.kind === 'chat-reasoning-content') &&
        (part.summary.length !== 0 || part.content?.length !== 1)) ||
        (evidence?.kind === 'anthropic-redacted-thinking' &&
          (part.summary.length !== 0 || part.content !== undefined)))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Signed or Chat thinking preserves one exact returned text field; redacted thinking has no readable content or summary.',
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

const PrefixSchema = z.strictObject({
  coveredMessages: z.int().positive(),
  prefixFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const GoogleContinuationSchema = PrefixSchema.extend({
  origin: OriginSchema.extend({
    protocol: z.literal('google-interactions'),
  }).readonly(),
  anchor: z
    .strictObject({
      interactionId: z.string().min(1),
      coveredSteps: z.int().positive(),
    })
    .readonly(),
}).readonly();
const ResponsesContinuationSchema = PrefixSchema.extend({
  origin: OriginSchema.extend({
    protocol: z.literal('openai-responses'),
  }).readonly(),
  anchor: z
    .strictObject({
      responseId: z.string().min(1),
      coveredItems: z.int().nonnegative(),
    })
    .readonly(),
}).readonly();
/** Provider acceleration of an exact prefix, never the conversation authority. */
export const ContinuationSchema = z.union([
  GoogleContinuationSchema,
  ResponsesContinuationSchema,
]);
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
const DisabledThinkingSchema = z.strictObject({ mode: z.literal('disabled') });
const AdaptiveThinkingSchema = z.strictObject({
  mode: z.literal('adaptive'),
  display: z.enum(['summarized', 'omitted']),
});
const BudgetedThinkingSchema = z.strictObject({
  mode: z.literal('enabled'),
  budgetTokens: z.int().min(1024),
  display: z.enum(['summarized', 'omitted']),
});
const AnthropicThinkingSchema = z.discriminatedUnion('mode', [
  DisabledThinkingSchema.readonly(),
  AdaptiveThinkingSchema.readonly(),
  BudgetedThinkingSchema.readonly(),
]);
const AuthoredThinkingSchema = z.discriminatedUnion('mode', [
  DisabledThinkingSchema.readonly(),
  AdaptiveThinkingSchema.readonly(),
  BudgetedThinkingSchema.partial({
    budgetTokens: true,
    display: true,
  }).readonly(),
]);
const EffortSchema = z
  .enum(['low', 'medium', 'high', 'xhigh', 'max'])
  .nullable();
const CacheSchema = z.enum(['disabled', '5m', '1h']);
const InferenceGeoSchema = z.enum(['global', 'us']).nullable();

/** Materialized input; no SDK value, credential, file path or storage reference. */
export const TurnRequestSchema = z
  .strictObject({
    mode: z.enum(['foreground', 'background']).optional(),
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
    serviceTier: z
      .enum(['fast', 'auto', 'standard-only'])
      .nullable()
      .optional(),
    thinking: AuthoredThinkingSchema.optional(),
    effort: EffortSchema.optional(),
    cache: CacheSchema.optional(),
    stopSequences: z.array(z.string()).readonly().optional(),
    inferenceGeo: InferenceGeoSchema.optional(),
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
const AnthropicControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  temperature: z.number().min(0).max(1).nullable(),
  parallelToolCalls: z.boolean(),
  toolChoice: ToolChoiceSchema,
  thinking: AnthropicThinkingSchema,
  effort: EffortSchema,
  cache: CacheSchema,
  stopSequences: z.array(z.string()).readonly(),
  serviceTier: z.enum(['auto', 'standard-only']),
  inferenceGeo: InferenceGeoSchema,
});
const ChatReasoningControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  temperature: z.number().min(0).max(2).nullable(),
  thinking: z
    .strictObject({ mode: z.enum(['enabled', 'disabled']) })
    .readonly(),
  effort: EffortSchema,
  toolChoice: ToolChoiceSchema,
});
const KimiControlsSchema = ChatReasoningControlsSchema.extend({
  preserveThinking: z.boolean(),
});
const GlmControlsSchema = ChatReasoningControlsSchema.extend({
  temperature: z.number().min(0).max(1).nullable(),
  clearThinking: z.boolean(),
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
    protocol: z.literal('deepseek-chat'),
    supportedEfforts: z.array(EffortSchema.unwrap()).readonly(),
    supportsForcedToolChoice: z.boolean(),
    defaults: ChatReasoningControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('kimi-chat'),
    thinkingControl: z.enum(['toggle', 'always', 'effort']),
    supportedEfforts: z.array(EffortSchema.unwrap()).readonly(),
    supportsForcedToolChoice: z.boolean(),
    temperatureByThinking: z
      .strictObject({
        enabled: z.number().min(0).max(2).nullable(),
        disabled: z.number().min(0).max(2).nullable(),
      })
      .readonly(),
    defaults: KimiControlsSchema.omit({
      toolChoice: true,
      temperature: true,
    }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('glm-chat'),
    supportsThinkingDisabled: z.boolean(),
    supportedEfforts: z.array(EffortSchema.unwrap()).readonly(),
    defaults: GlmControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('openai-responses'),
    background: z.enum(['supported', 'unsupported']),
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
  BindingSchema.extend({
    protocol: z.literal('anthropic-messages'),
    supportsTemperature: z.boolean(),
    supportsForcedToolChoice: z.boolean(),
    defaults: AnthropicControlsSchema.omit({ toolChoice: true }).readonly(),
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
            'A model without temperature support requires a null default.',
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
export type ChatConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'openai-chat' | 'deepseek-chat' | 'kimi-chat' | 'glm-chat' }
>;
export type GoogleInteractionsConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'google-interactions' }
>;
export type OpenAIResponsesConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'openai-responses' }
>;
export type AnthropicMessagesConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'anthropic-messages' }
>;

const PreparedInputSchema = OriginSchema.extend({
  mode: z.literal('foreground'),
  system: z.string().optional(),
  messages: PreparedHistorySchema,
  tools: ToolDefinitionsSchema,
});
const ResponsesPreparedSchema = PreparedInputSchema.extend({
  protocol: z.literal('openai-responses'),
  controls: ResponsesControlsSchema.readonly(),
  continuation: ResponsesContinuationSchema.optional(),
});
/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = z.discriminatedUnion('mode', [
  z.discriminatedUnion('protocol', [
    PreparedInputSchema.extend({
      protocol: z.literal('openai-chat'),
      controls: OpenAIControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('google-interactions'),
      controls: GoogleControlsSchema.readonly(),
      continuation: GoogleContinuationSchema.optional(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('deepseek-chat'),
      controls: ChatReasoningControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('kimi-chat'),
      controls: KimiControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('glm-chat'),
      controls: GlmControlsSchema.readonly(),
    }).readonly(),
    ResponsesPreparedSchema.readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('anthropic-messages'),
      controls: AnthropicControlsSchema.readonly(),
    }).readonly(),
  ]),
  ResponsesPreparedSchema.extend({ mode: z.literal('background') }).readonly(),
]);
export type ResolvedTurn = z.infer<typeof ResolvedTurnSchema>;

const UsageSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
    cachedInputTokens: z.int().nonnegative().nullable(),
    reasoningTokens: z.int().nonnegative().nullable(),
    providerUsage: z
      .strictObject({
        kind: z.literal('anthropic'),
        uncachedInputTokens: z.int().nonnegative().nullable(),
        cacheCreationTokens: z.int().nonnegative().nullable(),
        cacheCreation5mTokens: z.int().nonnegative().nullable(),
        cacheCreation1hTokens: z.int().nonnegative().nullable(),
        serviceTier: z.enum(['standard', 'priority', 'batch']).nullable(),
        inferenceGeo: z.string().nullable(),
      })
      .readonly()
      .optional(),
  })
  .readonly();

const IdentitySchema = z.strictObject({
  providerResponseId: z.string().min(1),
  requestedOrigin: ModelOriginSchema,
  returnedModel: z.string().min(1).nullable(),
});

/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = z
  .strictObject({
    ...IdentitySchema.shape,
    modelFingerprint: z.string().nullable(),
    content: ContentSchema,
    finishReason: z.enum([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'stop-sequence',
      'refusal',
      'context-window-exceeded',
    ]),
    stopSequence: z.string().optional(),
    refusalEvidence: z
      .strictObject({
        kind: z.literal('anthropic-refusal'),
        category: z
          .enum([
            'cyber',
            'bio',
            'frontier_llm',
            'reasoning_extraction',
            'general_harms',
          ])
          .nullable(),
        explanation: z.string().nullable(),
      })
      .readonly()
      .nullable()
      .optional(),
    /** Unknown counts remain unknown, including within a partial receipt. */
    usage: UsageSchema.nullable(),
    continuation: ContinuationSchema.optional(),
  })
  .superRefine((result, ctx) => {
    validateAssistantContent(result.requestedOrigin, result.content, ctx);
    if (
      (result.finishReason === 'stop-sequence') !==
      (result.stopSequence !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['stopSequence'],
        message:
          'A stop-sequence outcome requires its exact matched sequence, and no other outcome has one.',
      });
    }
    if (
      (result.refusalEvidence !== undefined &&
        result.requestedOrigin.protocol !== 'anthropic-messages') ||
      (result.refusalEvidence != null && result.finishReason !== 'refusal') ||
      (result.usage?.providerUsage !== undefined &&
        result.requestedOrigin.protocol !== 'anthropic-messages')
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Provider refusal and usage evidence require their original protocol and outcome.',
      });
    }
    if (
      result.finishReason !== 'length' &&
      result.finishReason !== 'content-filter' &&
      result.finishReason !== 'context-window-exceeded' &&
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

// Identity evidence is neither background acceptance nor cancellation.
const IdentifiedEventSchema = IdentitySchema.extend({
  kind: z.literal('identified'),
});
const DeltaEventSchema = z.strictObject({
  kind: z.literal('delta'),
  part: z.enum(['text', 'refusal', 'reasoning']),
  text: z.string(),
  // Position in this provider response, not a canonical-history or tool-call ordinal.
  providerItemIndex: z.int().nonnegative().nullable(),
});
const PhaseEventSchema = DeltaEventSchema.omit({ text: true }).extend({
  kind: z.literal('phase'),
  // Text denotes the assistant output block, including any refusal children.
  part: DeltaEventSchema.shape.part.exclude(['refusal']),
  boundary: z.enum(['start', 'end']),
});
const CompletedEventSchema = z.strictObject({
  kind: z.literal('completed'),
  result: TurnResultSchema,
});
const TurnEventSchema = z.discriminatedUnion('kind', [
  IdentifiedEventSchema.readonly(),
  DeltaEventSchema.readonly(),
  PhaseEventSchema.readonly(),
  CompletedEventSchema.readonly(),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

/** Enough evidence to observe accepted remote work, without a second transcript. */
export const RemoteOperationSchema = z
  .strictObject({
    origin: OriginSchema.extend({
      protocol: z.literal('openai-responses'),
    }).readonly(),
    providerResponseId: z.string().min(1),
    afterSequence: z.int().nonnegative().nullable(),
  })
  .readonly();
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;
export const BackgroundSubmissionSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('accepted'),
      operation: RemoteOperationSchema,
      returnedModel: z.string().min(1).nullable(),
    })
    .readonly(),
  CompletedEventSchema.readonly(),
]);
export type BackgroundSubmission = z.infer<typeof BackgroundSubmissionSchema>;
const SequenceSchema = z.strictObject({ afterSequence: z.int().nonnegative() });
/** A delivered sequence is not a durable acknowledgement by its consumer. */
export const BackgroundEventSchema = z.discriminatedUnion('kind', [
  IdentifiedEventSchema.extend(SequenceSchema.shape).readonly(),
  DeltaEventSchema.extend(SequenceSchema.shape).readonly(),
  PhaseEventSchema.extend(SequenceSchema.shape).readonly(),
  CompletedEventSchema.extend(SequenceSchema.shape).readonly(),
  SequenceSchema.extend({ kind: z.literal('cursor') }).readonly(),
]);
export type BackgroundEvent = z.infer<typeof BackgroundEventSchema>;
/** A cancellation response reports the state observed, not which request won a race. */
export const CancellationEvidenceSchema = z.discriminatedUnion('kind', [
  IdentitySchema.extend({ kind: z.literal('confirmed-cancelled') }).readonly(),
  IdentitySchema.extend({
    kind: z.literal('observed-terminal'),
    status: z.enum(['completed', 'failed', 'incomplete']),
  }).readonly(),
  IdentitySchema.extend({
    kind: z.literal('unconfirmed'),
    status: z.enum(['queued', 'in_progress']),
  }).readonly(),
]);
export type CancellationEvidence = z.infer<typeof CancellationEvidenceSchema>;
/** Absolute original deadline; reconnecting does not replenish it. */
export const ObservationPolicySchema = z
  .strictObject({
    deadlineAtMs: z.int().nonnegative(),
  })
  .readonly();

const ModelErrorFieldsSchema = z.strictObject({
  kind: z.enum([
    'invalid-request',
    'unsupported',
    'authentication',
    'transport',
    'provider-rejection',
    'malformed-output',
    'observation-deadline',
  ]),
  message: z.string(),
  requestId: z.string().optional(),
  responseId: z.string().optional(),
  model: z.string().optional(),
  status: z.int().optional(),
  operation: RemoteOperationSchema.optional(),
});
/** Typed provider failure. Fiber interruption remains outside this channel. */
export class ModelError extends Data.TaggedError('ModelError')<
  z.infer<typeof ModelErrorFieldsSchema> & { readonly cause?: unknown }
> {}

/** A configured executable value; it owns neither conversation nor retry policy. */
export interface Model {
  prepareTurn(request: TurnRequest): Effect.Effect<ResolvedTurn, ModelError>;
  streamTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Stream.Stream<TurnEvent, ModelError>;
  generateTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Effect.Effect<TurnResult, ModelError>;
  readonly background?: {
    submit(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
    ): Effect.Effect<BackgroundSubmission, ModelError>;
    observe(
      operation: RemoteOperation,
      policy: z.infer<typeof ObservationPolicySchema>,
    ): Stream.Stream<BackgroundEvent, ModelError>;
    cancel(
      operation: RemoteOperation,
    ): Effect.Effect<CancellationEvidence, ModelError>;
  };
}
