/**
 * `@texra-ai/llm/turn` — the package's public entry for the turn contract.
 *
 * What a caller reads and writes is here: the request, the selected binding,
 * the prepared and resolved turn, its result and its events, and the `Model`
 * interface that executes one. The modules this contract was split into —
 * `protocol.ts`, `message.ts` and `errors.ts` — define the symbols they own,
 * and this entry re-exports the ones consumers read, so a consumer imports
 * this one subpath and never the file layout behind it. The protocol helpers
 * in `errors.ts` and `transport.ts` stay package-internal.
 */
// Third-party imports
import { Effect, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical protocol binding
import {
  BackgroundCapabilitySchema,
  BindingSchema,
  EditorBindingSchema,
  EditorOriginSchema,
  JsonObjectSchema,
  OriginSchema,
  sameModelOrigin,
} from './protocol.js';

// Local imports - canonical messages
import {
  ContentSchema,
  ContinuationSchema,
  EditorContentSchema,
  EVIDENCE_PROTOCOL,
  GoogleContinuationSchema,
  MiniMaxDetectionSchema,
  PreparedHistorySchema,
  ResponsesContinuationSchema,
  validateAssistantContent,
  type AssistantMessage,
} from './message.js';

// Local imports - canonical model errors
import {
  ModelError,
  RemoteOperationSchema,
  type RemoteOperation,
} from './errors.js';

// The contract symbols the modules behind this subpath define.
export {
  JsonObjectSchema,
  ModelOriginSchema,
  sameModelOrigin,
  TurnProtocolSchema,
} from './protocol.js';
export type { ModelOrigin } from './protocol.js';
export {
  ContinuationSchema,
  MessageSchema,
  PreparedHistorySchema,
} from './message.js';
export type { Continuation } from './message.js';
export { ModelError, RemoteOperationSchema } from './errors.js';
export type { RemoteOperation } from './errors.js';

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

const ToolChoiceSchema = z.union([
  z.literal('auto'),
  z.strictObject({ name: z.string().min(1) }).readonly(),
]);
// This package speaks its own protocol vocabulary and takes no llm-zoo
// dependency; the registry's enum is checked against this one by assignment at
// the `modelBinding.ts` call sites that feed it.
const ReasoningEffortSchema = z
  .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  .nullable();
const ResponsesReasoningSchema = z
  .strictObject({
    effort: ReasoningEffortSchema,
    mode: z.enum(['standard', 'pro']).nullable(),
    summary: z.enum(['auto', 'concise', 'detailed']).nullable(),
  })
  .readonly()
  .nullable();
const DisabledThinkingSchema = z.strictObject({ mode: z.literal('disabled') });
const ThinkingDisplaySchema = z.enum(['summarized', 'omitted']);
const AdaptiveThinkingSchema = z.strictObject({
  mode: z.literal('adaptive'),
  display: ThinkingDisplaySchema,
});
const BudgetedThinkingSchema = z.strictObject({
  mode: z.literal('enabled'),
  budgetTokens: z.int().min(1024),
  display: ThinkingDisplaySchema,
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
const EffortSchema = ReasoningEffortSchema.unwrap()
  .exclude(['none', 'minimal'])
  .nullable();
const CacheSchema = z.enum(['disabled', '5m', '1h']);
const ThinkingLevelSchema = z.enum(['low', 'medium', 'high']);

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
    thinkingLevel: ThinkingLevelSchema.optional(),
    reasoning: ResponsesReasoningSchema.optional(),
    serviceTier: z.literal('fast').nullable().optional(),
    thinking: AuthoredThinkingSchema.optional(),
    effort: ReasoningEffortSchema.optional(),
    cache: CacheSchema.optional(),
    stopSequences: z.array(z.string()).readonly().optional(),
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
const OpenAIChatControlsSchema = OpenAIControlsSchema.extend({
  temperature: OpenAIControlsSchema.shape.temperature.nullable(),
  effort: ReasoningEffortSchema,
});
const GoogleControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  store: z.boolean(),
  thinkingLevel: ThinkingLevelSchema,
  toolChoice: ToolChoiceSchema,
});
const ResponsesControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive().nullable(),
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
});
const ChatReasoningControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  temperature: z.number().min(0).max(2).nullable(),
  parallelToolCalls: z.boolean(),
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
const XaiEffortSchema = EffortSchema.unwrap().exclude(['max']).nullable();
const XaiControlsSchema = OpenAIControlsSchema.extend({
  temperature: OpenAIControlsSchema.shape.temperature.nullable(),
  effort: XaiEffortSchema,
});
const DashscopeControlsSchema = OpenAIControlsSchema.extend({
  temperature: z.number().min(0).lt(2),
  stopSequences: TurnRequestSchema.unwrap().shape.stopSequences.unwrap(),
  thinking: DisabledThinkingSchema.readonly(),
});
const MiniMaxControlsSchema = OpenAIControlsSchema.extend({
  reasoningSplit: z.boolean(),
  stopSequences: TurnRequestSchema.unwrap().shape.stopSequences.unwrap(),
});
const OpenRouterControlsSchema = z.strictObject({
  maxOutputTokens: z.int().positive(),
  temperature: z.number().min(0).max(2).nullable(),
  effort: ReasoningEffortSchema,
  stopSequences: z.array(z.string()).readonly(),
  toolChoice: ToolChoiceSchema,
});
const EditorControlsSchema = z.strictObject({
  justification: z.string(),
  toolChoice: z.literal('auto'),
});

/** Refinement guard: a route without temperature support must default to null. */
function validateTemperatureDefault(
  configuration: {
    readonly supportsTemperature: boolean;
    readonly defaults: { readonly temperature: number | null };
  },
  ctx: z.RefinementCtx,
): void {
  if (
    !configuration.supportsTemperature &&
    configuration.defaults.temperature !== null
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaults', 'temperature'],
      message: 'A model without temperature support requires a null default.',
    });
  }
}

/** Refinement guard: the default effort must be one the selected route supports. */
function validateEffortDefault<E extends string>(
  configuration: {
    readonly supportedEfforts: readonly E[];
    readonly defaults: { readonly effort: E | null };
  },
  ctx: z.RefinementCtx,
): void {
  if (
    configuration.defaults.effort !== null &&
    !configuration.supportedEfforts.includes(configuration.defaults.effort)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaults', 'effort'],
      message:
        'The default reasoning effort must be supported by the selected route.',
    });
  }
}

/** Already-selected protocol binding and defaults, provided by the application. */
export const ModelConfigurationSchema = z.discriminatedUnion('protocol', [
  BindingSchema.extend({
    protocol: z.literal('minimax-chat'),
    reasoningSplit: z.boolean(),
    defaults: MiniMaxControlsSchema.omit({
      toolChoice: true,
      reasoningSplit: true,
    }).readonly(),
  }).readonly(),
  EditorBindingSchema.extend({
    protocol: z.literal('vscode-lm'),
    supportsImageInput: z.boolean(),
    supportsToolCalling: z.boolean(),
    defaults: EditorControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('openrouter-chat'),
    supportsTemperature: z.boolean(),
    supportsForcedToolChoice: z.boolean(),
    supportsImageInput: z.boolean(),
    supportsAudioInput: z.boolean(),
    supportedEfforts: z.array(ReasoningEffortSchema.unwrap()).readonly(),
    defaults: OpenRouterControlsSchema.omit({ toolChoice: true }).readonly(),
  })
    .superRefine((configuration, ctx) => {
      validateTemperatureDefault(configuration, ctx);
      validateEffortDefault(configuration, ctx);
    })
    .readonly(),
  BindingSchema.extend({
    protocol: z.literal('openai-chat'),
    supportsTemperature: z.boolean(),
    supportedEfforts: z.array(ReasoningEffortSchema.unwrap()).readonly(),
    defaults: OpenAIChatControlsSchema.omit({ toolChoice: true }).readonly(),
  })
    .superRefine((configuration, ctx) => {
      validateTemperatureDefault(configuration, ctx);
      validateEffortDefault(configuration, ctx);
    })
    .readonly(),
  BindingSchema.extend({
    protocol: z.literal('google-interactions'),
    background: BackgroundCapabilitySchema,
    supportsInputTokenEstimation: z.boolean(),
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
    supportsImageInput: z.boolean(),
    supportsInputTokenEstimation: z.boolean(),
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
    supportsImageInput: z.boolean(),
    supportsThinkingDisabled: z.boolean(),
    supportedEfforts: z.array(EffortSchema.unwrap()).readonly(),
    defaults: GlmControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('xai-chat'),
    supportsImageInput: z.boolean(),
    supportedEfforts: z.array(XaiEffortSchema.unwrap()).readonly(),
    defaults: XaiControlsSchema.omit({ toolChoice: true }).readonly(),
  })
    .superRefine((configuration, ctx) => {
      validateEffortDefault(configuration, ctx);
    })
    .readonly(),
  BindingSchema.extend({
    protocol: z.literal('dashscope-chat'),
    defaults: DashscopeControlsSchema.omit({ toolChoice: true }).readonly(),
  }).readonly(),
  BindingSchema.extend({
    protocol: z.literal('openai-responses'),
    background: BackgroundCapabilitySchema,
    supportsInputTokenEstimation: z.boolean(),
    supportsTemperature: z.boolean(),
    supportsMaxOutputTokens: z.boolean(),
    supportsStorage: z.boolean(),
    supportsResponseChaining: z.boolean(),
    /** The route takes input files; a document is refused locally otherwise. */
    supportsDocumentInput: z.boolean(),
    webSocketStreamParameter: z.enum(['implicit', 'required']),
    allowedReasoningEfforts: z
      .array(ResponsesReasoningSchema.unwrap().unwrap().shape.effort.unwrap())
      .readonly(),
    instructions: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('optional') }).readonly(),
      z
        .strictObject({
          kind: z.literal('required'),
          fallback: z.string().refine((value) => value.trim().length > 0, {
            message: 'Required instructions need a nonblank fallback.',
          }),
        })
        .readonly(),
    ]),
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
      if (
        !configuration.supportsMaxOutputTokens &&
        configuration.defaults.maxOutputTokens !== null
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaults', 'maxOutputTokens'],
          message:
            'A protocol without output-limit support requires a null default.',
        });
      }
      if (!configuration.supportsStorage && configuration.defaults.store) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaults', 'store'],
          message:
            'A protocol without persistent storage requires store:false.',
        });
      }
      const effort = configuration.defaults.reasoning?.effort;
      if (
        effort != null &&
        !configuration.allowedReasoningEfforts.includes(effort)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaults', 'reasoning', 'effort'],
          message: 'The default reasoning effort must be allowed by the route.',
        });
      }
    })
    .readonly(),
  BindingSchema.extend({
    protocol: z.literal('anthropic-messages'),
    supportsInputTokenEstimation: z.boolean(),
    supportsTemperature: z.boolean(),
    supportsForcedToolChoice: z.boolean(),
    defaults: AnthropicControlsSchema.omit({ toolChoice: true }).readonly(),
  })
    .superRefine((configuration, ctx) => {
      validateTemperatureDefault(configuration, ctx);
    })
    .readonly(),
]);
export type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>;
export type ChatConfiguration = Extract<
  ModelConfiguration,
  {
    protocol:
      | 'openai-chat'
      | 'deepseek-chat'
      | 'kimi-chat'
      | 'glm-chat'
      | 'xai-chat'
      | 'dashscope-chat'
      | 'minimax-chat';
  }
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
export type OpenRouterConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'openrouter-chat' }
>;
export type VscodeLanguageModelConfiguration = Extract<
  ModelConfiguration,
  { protocol: 'vscode-lm' }
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
const GooglePreparedSchema = PreparedInputSchema.extend({
  protocol: z.literal('google-interactions'),
  controls: GoogleControlsSchema.readonly(),
  continuation: GoogleContinuationSchema.optional(),
});
const HttpTransportSchema = z
  .strictObject({ kind: z.literal('http') })
  .readonly();
/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = z.discriminatedUnion('mode', [
  z.discriminatedUnion('protocol', [
    PreparedInputSchema.extend({
      protocol: z.literal('minimax-chat'),
      controls: MiniMaxControlsSchema.readonly(),
    }).readonly(),
    EditorOriginSchema.extend({
      ...PreparedInputSchema.pick({
        mode: true,
        system: true,
        messages: true,
        tools: true,
      }).shape,
      // An editor object acquisition is not an account or durable origin identity.
      acquisitionId: z.uuid(),
      controls: EditorControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('openrouter-chat'),
      controls: OpenRouterControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('openai-chat'),
      controls: OpenAIChatControlsSchema.readonly(),
    }).readonly(),
    GooglePreparedSchema.readonly(),
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
    PreparedInputSchema.extend({
      protocol: z.literal('xai-chat'),
      controls: XaiControlsSchema.readonly(),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('dashscope-chat'),
      controls: DashscopeControlsSchema.readonly(),
    }).readonly(),
    ResponsesPreparedSchema.extend({
      transport: z.discriminatedUnion('kind', [
        HttpTransportSchema,
        z
          .strictObject({
            kind: z.literal('websocket'),
            connectionId: z.uuid(),
          })
          .readonly(),
      ]),
    }).readonly(),
    PreparedInputSchema.extend({
      protocol: z.literal('anthropic-messages'),
      controls: AnthropicControlsSchema.readonly(),
    }).readonly(),
  ]),
  z.discriminatedUnion('protocol', [
    ResponsesPreparedSchema.extend({
      mode: z.literal('background'),
      transport: HttpTransportSchema,
    }).readonly(),
    GooglePreparedSchema.extend({ mode: z.literal('background') }).readonly(),
  ]),
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
      .discriminatedUnion('kind', [
        z
          .strictObject({
            kind: z.literal('google'),
            /** Reported tool-use prompt count; absence does not mean zero. */
            toolUsePromptTokens: z.int().nonnegative().nullable(),
          })
          .readonly(),
        z
          .strictObject({
            kind: z.literal('minimax'),
            totalCharacters: z.int().nonnegative(),
          })
          .readonly(),
        z
          .strictObject({
            kind: z.literal('xai'),
            costInUsdTicks: z.int().nonnegative().nullable(),
            serviceTier: z.enum(['default', 'priority']).nullable(),
          })
          .readonly(),
        z
          .strictObject({
            kind: z.literal('anthropic'),
            uncachedInputTokens: z.int().nonnegative().nullable(),
            cacheCreationTokens: z.int().nonnegative().nullable(),
            cacheCreation5mTokens: z.int().nonnegative().nullable(),
            cacheCreation1hTokens: z.int().nonnegative().nullable(),
            serviceTier: z.enum(['standard', 'priority', 'batch']).nullable(),
            inferenceGeo: z.string().nullable(),
          })
          .readonly(),
        z
          .strictObject({
            kind: z.literal('openrouter'),
            cost: z.number().nullable().optional(),
            isByok: z.boolean().optional(),
            costDetails: z
              .strictObject({
                upstreamInferenceCost: z.number().nullable().optional(),
                upstreamInferencePromptCost: z.number().nullable().optional(),
                upstreamInferenceCompletionsCost: z
                  .number()
                  .nullable()
                  .optional(),
                serverToolCost: z.number().nullable().optional(),
              })
              .readonly()
              .nullable()
              .optional(),
            inputDetails: z
              .strictObject({
                cacheWriteTokens: z.int().nonnegative().nullable().optional(),
                audioTokens: z.int().nonnegative().nullable().optional(),
                videoTokens: z.int().nonnegative().nullable().optional(),
              })
              .readonly()
              .nullable()
              .optional(),
            outputDetails: z
              .strictObject({
                audioTokens: z.int().nonnegative().nullable().optional(),
                acceptedPredictionTokens: z
                  .int()
                  .nonnegative()
                  .nullable()
                  .optional(),
                rejectedPredictionTokens: z
                  .int()
                  .nonnegative()
                  .nullable()
                  .optional(),
              })
              .readonly()
              .nullable()
              .optional(),
            serverToolUseDetails: z
              .strictObject({
                toolCallsRequested: z.int().nonnegative().nullable().optional(),
                toolCallsExecuted: z.int().nonnegative().nullable().optional(),
                webSearchRequests: z.int().nonnegative().nullable().optional(),
              })
              .readonly()
              .nullable()
              .optional(),
            serviceTier: z.string().nullable().optional(),
          })
          .readonly(),
      ])
      .optional(),
  })
  .readonly();

const IdentitySchema = z.strictObject({
  providerResponseId: z.string().min(1),
  requestedOrigin: OriginSchema.readonly(),
  returnedModel: z.string().min(1).nullable(),
});

const HttpTurnResultSchema = z
  .strictObject({
    kind: z.literal('http'),
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
    finishEvidence: z
      .discriminatedUnion('kind', [
        MiniMaxDetectionSchema.extend({
          kind: z.literal('minimax'),
        }).readonly(),
        z
          .strictObject({
            kind: z.literal('google-interactions'),
            // Reported verbatim: the interaction status vocabulary is open, so
            // an unrecognized status is preserved rather than dropped.
            status: z.string().min(1),
            // Null when the interaction reports no reason for ending, which is
            // every status Google returns today.
            terminalReason: z.string().min(1).nullable(),
          })
          .readonly(),
        z
          .strictObject({
            kind: z.literal('openai-responses'),
            status: z.enum([
              'queued',
              'in_progress',
              'completed',
              'failed',
              'cancelled',
              'incomplete',
            ]),
            // Present only on an incomplete response.
            incompleteReason: z
              .enum(['max_output_tokens', 'content_filter'])
              .nullable(),
          })
          .readonly(),
      ])
      .optional(),
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
    const usageKind = result.usage?.providerUsage?.kind;
    const finishKind = result.finishEvidence?.kind;
    if (
      (result.refusalEvidence !== undefined &&
        result.requestedOrigin.protocol !== 'anthropic-messages') ||
      (result.refusalEvidence != null && result.finishReason !== 'refusal') ||
      (usageKind != null &&
        result.requestedOrigin.protocol !== EVIDENCE_PROTOCOL[usageKind]) ||
      (finishKind != null &&
        result.requestedOrigin.protocol !== EVIDENCE_PROTOCOL[finishKind])
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Provider refusal, finish and usage evidence require their original protocol and outcome.',
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
const EditorTurnResultSchema = z
  .strictObject({
    kind: z.literal('editor'),
    requestedOrigin: EditorOriginSchema.readonly(),
    // Normal editor EOF reports none of these provider facts.
    providerResponseId: z.null(),
    returnedModel: z.null(),
    modelFingerprint: z.null(),
    finishReason: z.null(),
    usage: z.null(),
    content: EditorContentSchema,
  })
  .superRefine((result, ctx) =>
    validateAssistantContent(result.requestedOrigin, result.content, ctx),
  )
  .readonly();
/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = z.discriminatedUnion('kind', [
  HttpTurnResultSchema,
  EditorTurnResultSchema,
]);
export type TurnResult = z.infer<typeof TurnResultSchema>;

/** The assistant message a completed turn contributes to canonical history. */
export function assistantMessageFromResult(
  result: TurnResult,
): AssistantMessage {
  return {
    role: 'assistant',
    origin: result.requestedOrigin,
    content: result.content,
  };
}

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
const HttpCompletedEventSchema = CompletedEventSchema.extend({
  result: HttpTurnResultSchema,
});
const TurnEventSchema = z.discriminatedUnion('kind', [
  IdentifiedEventSchema.readonly(),
  DeltaEventSchema.readonly(),
  PhaseEventSchema.readonly(),
  CompletedEventSchema.readonly(),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

export const BackgroundSubmissionSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('accepted'),
      operation: RemoteOperationSchema,
      returnedModel: z.string().min(1).nullable(),
    })
    .readonly(),
  HttpCompletedEventSchema.readonly(),
]);
export type BackgroundSubmission = z.infer<typeof BackgroundSubmissionSchema>;
const SequenceSchema = z.strictObject({ afterSequence: z.int().nonnegative() });
/** A delivered sequence is not a durable acknowledgement by its consumer. */
const SequencedBackgroundEventSchema = z.discriminatedUnion('kind', [
  IdentifiedEventSchema.extend({
    ...SequenceSchema.shape,
    requestedOrigin: OriginSchema.extend({
      protocol: z.literal('openai-responses'),
    }).readonly(),
  }).readonly(),
  DeltaEventSchema.extend(SequenceSchema.shape).readonly(),
  PhaseEventSchema.extend(SequenceSchema.shape).readonly(),
  HttpCompletedEventSchema.extend({
    ...SequenceSchema.shape,
    result: HttpTurnResultSchema.refine(
      (result) => result.requestedOrigin.protocol === 'openai-responses',
    ),
  }).readonly(),
  SequenceSchema.extend({ kind: z.literal('cursor') }).readonly(),
]);
/** Polling can report identity and completion, but cannot invent stream progress. */
export const BackgroundEventSchema = z.union([
  SequencedBackgroundEventSchema,
  IdentifiedEventSchema.extend({
    afterSequence: z.null(),
    requestedOrigin: OriginSchema.extend({
      protocol: z.literal('google-interactions'),
    }).readonly(),
  }).readonly(),
  HttpCompletedEventSchema.extend({
    afterSequence: z.null(),
    result: HttpTurnResultSchema.refine(
      (result) => result.requestedOrigin.protocol === 'google-interactions',
    ),
  }).readonly(),
]);
export type BackgroundEvent = z.infer<typeof BackgroundEventSchema>;
/** A cancellation response reports the state observed, not which request won a race. */
export const CancellationEvidenceSchema = z.discriminatedUnion('kind', [
  IdentitySchema.extend({ kind: z.literal('confirmed-cancelled') }).readonly(),
  IdentitySchema.extend({
    kind: z.literal('observed-terminal'),
    status: z.enum([
      'completed',
      'requires_action',
      'failed',
      'incomplete',
      'budget_exceeded',
    ]),
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

/** An input estimate with its counted scope, not generation usage. */
export const InputTokenEstimateSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative(),
    coverage: z.enum([
      'kimi-messages',
      'google-converted-content',
      'anthropic-message-input',
      'responses-input',
    ]),
  })
  .readonly();
export type InputTokenEstimate = z.infer<typeof InputTokenEstimateSchema>;

/** The bytes an upload takes. */
export const FileUploadSchema = z
  .strictObject({
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    base64: z.base64(),
  })
  .readonly();
export type FileUpload = z.infer<typeof FileUploadSchema>;

/**
 * The lifetime every upload asks its provider for, in seconds: one day, long
 * enough for a typical run and inside both files endpoints' accepted range
 * (OpenAI `expires_after.seconds` 3600-2592000, Anthropic
 * `expires_in_seconds` 3600-7776000, per the pinned SDK typings). Without it
 * OpenAI keeps a non-batch file until it is deleted. A binding deletes what
 * it uploaded when its scope closes; this bound is what still clears a file
 * a crashed process never got to delete.
 */
export const FILE_UPLOAD_LIFETIME_SECONDS = 86_400;

/** A file a binding uploaded and could not confirm it deleted. */
export interface UnreleasedUpload {
  readonly fileId: string;
  readonly reason: string;
}

/** A configured executable value; it owns neither conversation nor retry policy. */
export interface Model {
  prepareTurn(request: TurnRequest): Effect.Effect<ResolvedTurn, ModelError>;
  streamTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Stream.Stream<TurnEvent, ModelError>;
  generateTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Effect.Effect<TurnResult, ModelError>;
  /**
   * Upload a document's bytes so later turns on this same model can send the
   * provider's file id in their place. The id lives only in this model's
   * memory, keyed by a digest of the bytes; nothing durable ever holds it,
   * so a new binding (a resumed run, a rebind, another model) starts empty
   * and sends bytes. Present only where the binding serves a files endpoint.
   */
  uploadFile?(file: FileUpload): Effect.Effect<void, ModelError>;
  /**
   * Delete every file `uploadFile` created, concurrently under one deadline,
   * and forget them, so no later turn can send an id that no longer resolves.
   * Never fails: what could not be confirmed deleted is returned.
   */
  releaseUploads?(): Effect.Effect<readonly UnreleasedUpload[]>;
  /** Estimate supported prepared input and report the counted scope. */
  estimateInputTokens?(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Effect.Effect<InputTokenEstimate, ModelError>;
  readonly background?: {
    submit(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
    ): Effect.Effect<BackgroundSubmission, ModelError>;
    /**
     * Observe the remote work `operation` names. The admitted turn is passed
     * back because a completion's continuation anchors to the exact history
     * prefix it covers, which the handle deliberately does not copy: an
     * accepted operation is a handle, and the ledger keeps no second
     * transcript. The caller owns that history and re-derives the same
     * admitted turn when a resume observes an operation it did not submit.
     * Re-derivation can drift: when the turn no longer fingerprints as the
     * one the operation admitted, the result is still delivered and the
     * completion simply leaves no continuation.
     */
    observe(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
      operation: RemoteOperation,
      policy: z.infer<typeof ObservationPolicySchema>,
    ): Stream.Stream<BackgroundEvent, ModelError>;
    cancel(
      operation: RemoteOperation,
    ): Effect.Effect<CancellationEvidence, ModelError>;
  };
}

/** The `generateTurn` every model shares: the stream's completed result. */
export const completedTurn = Effect.fn('llm.generateTurn')(function* (
  events: Stream.Stream<TurnEvent, ModelError>,
) {
  const result = yield* Stream.runFold(
    events,
    () => null as TurnResult | null,
    (current, event) => (event.kind === 'completed' ? event.result : current),
  );
  if (result === null)
    return yield* new ModelError({
      kind: 'malformed-output',
      message: 'The model stream produced no completed result.',
    });
  return result;
});
