// Third-party imports
import { Cause, Data, Effect, Exit, type Scope, Stream } from 'effect';
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
/**
 * Scheme, host and path only. The origin is written into durable rows that
 * are never scrubbed, and `z.url()` alone admits `user:key@host`,
 * `?api-key=` and `#api-key=` alike.
 */
const EndpointSchema = z.url().refine(
  (endpoint) => {
    const url = new URL(endpoint);
    return url.username === '' && url.password === '' && !/[?#]/.test(endpoint);
  },
  { message: 'Endpoints carry no userinfo, query string or fragment.' },
);
const BindingSchema = z.strictObject({
  requestedModel: z.string().min(1),
  deployment: z
    .strictObject({
      endpoint: EndpointSchema,
      credentialScope: z.string().min(1),
    })
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
    'xai-chat',
    'dashscope-chat',
    'minimax-chat',
    'openrouter-chat',
  ]),
  codecVersion: z.literal(1),
});
const EditorBindingSchema = BindingSchema.pick({ requestedModel: true }).extend(
  {
    deployment: z
      .strictObject({ vendor: z.string(), version: z.string() })
      .readonly(),
  },
);
const EditorOriginSchema = EditorBindingSchema.extend({
  protocol: z.literal('vscode-lm'),
  codecVersion: OriginSchema.shape.codecVersion,
});

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = z.discriminatedUnion('protocol', [
  OriginSchema.readonly(),
  EditorOriginSchema.readonly(),
]);
export type ModelOrigin = z.infer<typeof ModelOriginSchema>;

/** Compares the complete non-secret binding, not runtime lineage. */
export function sameModelOrigin(
  left: ModelOrigin,
  right: ModelOrigin,
): boolean {
  if (
    left.protocol !== right.protocol ||
    left.codecVersion !== right.codecVersion ||
    left.requestedModel !== right.requestedModel
  ) {
    return false;
  }
  if (left.protocol === 'vscode-lm' || right.protocol === 'vscode-lm') {
    return (
      left.protocol === 'vscode-lm' &&
      right.protocol === 'vscode-lm' &&
      left.deployment.vendor === right.deployment.vendor &&
      left.deployment.version === right.deployment.version
    );
  }
  return (
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

const OpenRouterDetailMetadataSchema = z.strictObject({
  format: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  index: z.number().optional(),
});
const OpenRouterReasoningSchema = z
  .strictObject({
    kind: z.literal('openrouter-reasoning'),
    plain: z.string().nullable().optional(),
    details: z
      .array(
        z.discriminatedUnion('kind', [
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('text'),
            text: z.string().nullable().optional(),
            signature: z.string().nullable().optional(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('summary'),
            summary: z.string(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('encrypted'),
            data: z.string(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('server-tool-call'),
            toolName: z.string(),
            toolCallId: z.string().nullable().optional(),
            arguments: z.string(),
            result: z.string(),
          }).readonly(),
        ]),
      )
      .readonly()
      .nullable()
      .optional(),
  })
  .refine(
    (evidence) =>
      evidence.plain !== undefined || evidence.details !== undefined,
    {
      message:
        'OpenRouter reasoning preserves a reported plain or details field.',
    },
  )
  .readonly();
const OpenRouterFileAnnotationSchema = z
  .strictObject({
    kind: z.literal('file-annotation'),
    hash: z.string(),
    name: z.string().optional(),
    content: z
      .array(
        z.discriminatedUnion('kind', [
          TextPartSchema,
          z
            .strictObject({ kind: z.literal('image-url'), url: z.string() })
            .readonly(),
        ]),
      )
      .readonly()
      .optional(),
    evidence: z
      .strictObject({ kind: z.literal('openrouter-file-annotation') })
      .readonly(),
  })
  .readonly();
const MiniMaxReasoningSchema = z
  .strictObject({
    kind: z.literal('minimax-reasoning'),
    plain: z.string().optional(),
    details: z
      .array(
        z
          .strictObject({
            type: z.string().optional(),
            id: z.string().optional(),
            format: z.string().optional(),
            index: z.int().optional(),
            text: z.string().optional(),
          })
          .readonly(),
      )
      .readonly()
      .optional(),
  })
  .refine(
    (evidence) =>
      evidence.plain !== undefined || evidence.details !== undefined,
    {
      message: 'MiniMax reasoning preserves a reported plain or details field.',
    },
  )
  .readonly();
const MiniMaxDetectionSchema = z.strictObject({
  inputSensitive: z.boolean().optional(),
  inputSensitiveType: z.int().optional(),
  outputSensitive: z.boolean().optional(),
  outputSensitiveType: z.int().optional(),
  outputSensitiveInt: z.int().optional(),
});
const MessagePartSchema = z.strictObject({
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
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('openai-responses-message'),
          itemId: z.string().min(1),
          status: z.enum(['completed', 'incomplete']),
          phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('minimax-message'),
          name: z.string().optional(),
          audioContent: z.literal('').optional(),
        })
        .readonly(),
    ])
    .optional(),
});
const LocalCallPartSchema = z.strictObject({
  kind: z.literal('local-call'),
  providerCallId: z.string().min(1),
  name: z.string().min(1),
  /**
   * The provider's exact returned bytes, the one carrier of the arguments.
   * A JSON.parse then JSON.stringify round trip is not byte exact (it
   * truncates integers past 2^53, rewrites 1.0 as 1, collapses duplicate
   * keys and reorders integer-like keys), so the parse is never stored;
   * codecs parse these bytes where a request is lowered.
   */
  argumentsText: z.string(),
  evidence: z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('openai-responses-function-call'),
          itemId: z.string().min(1).optional(),
          status: z.literal('completed').optional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('minimax-function-call'),
          index: z.int().optional(),
        })
        .readonly(),
    ])
    .optional(),
});

const OutputPartSchema = z.discriminatedUnion('kind', [
  OpenRouterFileAnnotationSchema,
  z
    .strictObject({
      kind: z.literal('url-citation'),
      url: z.string(),
      title: z.string().optional(),
      startIndex: z.number().optional(),
      endIndex: z.number().optional(),
      content: z.string().optional(),
      evidence: z
        .strictObject({ kind: z.literal('openrouter-url-citation') })
        .readonly(),
    })
    .readonly(),
  MessagePartSchema.readonly(),
  z
    .strictObject({
      kind: z.literal('reasoning'),
      summary: z.array(TextPartSchema).readonly(),
      content: z.array(TextPartSchema).readonly().optional(),
      evidence: z
        .discriminatedUnion('kind', [
          OpenRouterReasoningSchema,
          MiniMaxReasoningSchema,
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
  LocalCallPartSchema.readonly(),
]);

export const ContentSchema = z.array(OutputPartSchema).readonly();
const EditorContentSchema = z
  .array(
    z.discriminatedUnion('kind', [
      MessagePartSchema.omit({ evidence: true })
        .extend({ content: z.array(TextPartSchema).readonly() })
        .readonly(),
      LocalCallPartSchema.omit({ evidence: true }).readonly(),
    ]),
  )
  .readonly();
const EVIDENCE_PROTOCOL = {
  'google-interactions-thought-signature': 'google-interactions',
  'openai-responses-message': 'openai-responses',
  'openai-responses-reasoning': 'openai-responses',
  'openai-responses-function-call': 'openai-responses',
  'anthropic-thinking-signature': 'anthropic-messages',
  'anthropic-redacted-thinking': 'anthropic-messages',
  'openrouter-reasoning': 'openrouter-chat',
  'openrouter-file-annotation': 'openrouter-chat',
  'openrouter-url-citation': 'openrouter-chat',
  'minimax-reasoning': 'minimax-chat',
  'minimax-message': 'minimax-chat',
  'minimax-function-call': 'minimax-chat',
  google: 'google-interactions',
  anthropic: 'anthropic-messages',
  xai: 'xai-chat',
  openrouter: 'openrouter-chat',
  minimax: 'minimax-chat',
  'google-interactions': 'google-interactions',
  'openai-responses': 'openai-responses',
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
        ? ![
            'deepseek-chat',
            'kimi-chat',
            'glm-chat',
            'xai-chat',
            'dashscope-chat',
          ].includes(origin.protocol)
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
        ((evidence?.kind === 'anthropic-redacted-thinking' ||
          evidence?.kind === 'openrouter-reasoning' ||
          evidence?.kind === 'minimax-reasoning') &&
          (part.summary.length !== 0 || part.content !== undefined)))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Signed or Chat thinking preserves one exact returned text field; redacted and grouped reasoning keep their content in provider evidence.',
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
    if (part.kind !== 'local-call') continue;
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

export const AssistantMessageSchema = z
  .strictObject({
    role: z.literal('assistant'),
    origin: ModelOriginSchema,
    content: ContentSchema,
  })
  .superRefine((message, ctx) => {
    if (message.origin.protocol === 'vscode-lm') {
      const parsed = EditorContentSchema.safeParse(message.content);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: ['content', ...issue.path] });
        }
      }
    }
    validateAssistantContent(message.origin, message.content, ctx);
  })
  .readonly();
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const MessageSchema = z.discriminatedUnion('role', [
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
export const PreparedHistorySchema = z
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
const ResponsesAnchorSchema = z.strictObject({
  responseId: z.string().min(1),
  coveredItems: z.int().nonnegative(),
});
const ResponsesContinuationSchema = PrefixSchema.extend({
  origin: OriginSchema.extend({
    protocol: z.literal('openai-responses'),
  }).readonly(),
  // Only a stored anchor is durable. A connection-scoped anchor named a single
  // websocket, so it was dead the moment the process exited, and reusing a dead
  // one failed the whole turn rather than dropping the acceleration. Keeping it
  // representable here would let a persisted value carry it.
  anchor: ResponsesAnchorSchema.extend({
    kind: z.literal('stored'),
  }).readonly(),
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
const EffortSchema = ReasoningEffortSchema.unwrap()
  .exclude(['none', 'minimal'])
  .nullable();
const CacheSchema = z.enum(['disabled', '5m', '1h']);

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
  thinkingLevel: z.enum(['low', 'medium', 'high']),
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
    background: z.enum(['supported', 'unsupported']),
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
    background: z.enum(['supported', 'unsupported']),
    supportsInputTokenEstimation: z.boolean(),
    supportsTemperature: z.boolean(),
    supportsMaxOutputTokens: z.boolean(),
    supportsStorage: z.boolean(),
    supportsResponseChaining: z.boolean(),
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
                imageTokens: z.int().nonnegative().nullable().optional(),
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
        z
          .strictObject({
            kind: z.literal('openrouter'),
            nativeFinishReason: z.string().nullable(),
          })
          .readonly(),
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

/** Enough evidence to observe accepted remote work, without a second transcript. */
const ResponsesOperationSchema = z
  .strictObject({
    origin: OriginSchema.extend({
      protocol: z.literal('openai-responses'),
    }).readonly(),
    providerResponseId: z.string().min(1),
    afterSequence: z.int().nonnegative().nullable(),
  })
  .readonly();
export const RemoteOperationSchema = z.union([
  ResponsesOperationSchema,
  ResponsesOperationSchema.unwrap()
    .extend({
      origin: OriginSchema.extend({
        protocol: z.literal('google-interactions'),
      }).readonly(),
      // Polling snapshots have no provider sequence or replay cursor.
      afterSequence: z.null(),
    })
    .readonly(),
]);
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;
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
  providerEvidence: z
    .discriminatedUnion('kind', [
      MiniMaxDetectionSchema.extend({
        kind: z.literal('minimax'),
        origin: OriginSchema.extend({
          protocol: z.literal('minimax-chat'),
        }).readonly(),
        statusCode: z.int(),
        statusMessage: z.string().optional(),
      }).readonly(),
      z
        .strictObject({
          kind: z.literal('openrouter'),
          origin: OriginSchema.extend({
            protocol: z.literal('openrouter-chat'),
          }).readonly(),
          fileAnnotations: z.array(OpenRouterFileAnnotationSchema).readonly(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('vscode-lm'),
          origin: EditorOriginSchema.readonly(),
          code: z.enum(['NoPermissions', 'Blocked', 'NotFound']),
        })
        .readonly(),
    ])
    .optional(),
});
/** Typed provider failure. Fiber interruption remains outside this channel. */
export class ModelError extends Data.TaggedError('ModelError')<
  z.infer<typeof ModelErrorFieldsSchema> & { readonly cause?: unknown }
> {}

/**
 * The request signal for a streamed body, with the body reader cancelled at
 * scope close. The cancel finalizer is registered before the signal's abort
 * finalizer, so LIFO order aborts the request before cancellation joins a
 * pending read. Cancel repeats an errored reader's original failure; only that
 * repeat (the abort reason or the primary transport cause) is dropped, and
 * distinct cleanup defects stay in the scope's combined failure.
 */
export const readerAbortSignal = (
  reader: () => ReadableStreamDefaultReader<unknown> | undefined,
): Effect.Effect<AbortSignal, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => {
      const body = reader();
      if (body === undefined) return Effect.void;
      return Effect.tryPromise({
        try: () => body.cancel(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          (signal.aborted && cause === signal.reason) ||
          (Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof ModelError &&
                reason.error.kind === 'transport' &&
                reason.error.cause === cause,
            ))
            ? Effect.void
            : Effect.die(cause),
        ),
        Effect.ensuring(Effect.sync(() => body.releaseLock())),
      );
    });
    const signal = yield* Effect.abortSignal;
    return signal;
  });

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

/** A configured executable value; it owns neither conversation nor retry policy. */
export interface Model {
  prepareTurn(request: TurnRequest): Effect.Effect<ResolvedTurn, ModelError>;
  streamTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Stream.Stream<TurnEvent, ModelError>;
  generateTurn(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Effect.Effect<TurnResult, ModelError>;
  /** Estimate supported prepared input and report the counted scope. */
  estimateInputTokens?(
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ): Effect.Effect<InputTokenEstimate, ModelError>;
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
