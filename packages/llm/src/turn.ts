/**
 * The turn contract: the request, the protocol configurations the binding
 * builds, the prepared and resolved turn, its result and its events, and the
 * `Model` interface that executes one. Origins live in `protocol.ts`,
 * messages in `message.ts` and failures in `errors.ts`; the package's `.`
 * entry names what a caller reads from each.
 */
// Third-party imports
import { Effect, Schema, Stream, Struct } from 'effect';

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

const ToolDefinitionSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String,
  parameters: JsonObjectSchema,
});
const ToolDefinitionsSchema = Schema.Array(ToolDefinitionSchema).check(
  Schema.makeFilter(
    (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
    { message: 'Tool definitions must have distinct names.' },
  ),
);

/** A non-negative integer: a token or item count. */
const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ToolChoiceSchema = Schema.Union([
  Schema.Literal('auto'),
  Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }),
]);
// This package speaks its own protocol vocabulary and takes no llm-zoo
// dependency; the registry's enum is checked against this one by assignment at
// the harness's model-access call sites that feed it.
const ReasoningEffortLevelSchema = Schema.Literals([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const ReasoningEffortSchema = Schema.NullOr(ReasoningEffortLevelSchema);
const ResponsesReasoningSchema = Schema.NullOr(
  Schema.Struct({
    effort: ReasoningEffortSchema,
    mode: Schema.NullOr(Schema.Literals(['standard', 'pro'])),
    summary: Schema.NullOr(Schema.Literals(['auto', 'concise', 'detailed'])),
  }),
);
const AnthropicThinkingSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('disabled') }),
  Schema.Struct({
    mode: Schema.Literal('adaptive'),
    display: Schema.Literal('summarized'),
  }),
  Schema.Struct({
    mode: Schema.Literal('enabled'),
    budgetTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024)),
    display: Schema.Literal('summarized'),
  }),
]);
const EffortSchema = Schema.NullOr(
  ReasoningEffortLevelSchema.pick(['low', 'medium', 'high', 'xhigh', 'max']),
);
const CacheSchema = Schema.Literals(['disabled', '5m']);
const ThinkingLevelSchema = Schema.Literals([
  'minimal',
  'low',
  'medium',
  'high',
]);

/** Materialized input; no SDK value, credential, file path or storage reference. */
export const TurnRequestSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literals(['foreground', 'background'])),
  system: Schema.optional(Schema.String),
  messages: PreparedHistorySchema,
  tools: Schema.optional(ToolDefinitionsSchema),
  toolChoice: Schema.optional(ToolChoiceSchema),
  maxOutputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  store: Schema.optional(Schema.Boolean),
  continuation: Schema.optional(ContinuationSchema),
  /** Groups the requests that share a prefix (a run's), for a provider
   *  that routes its prompt cache by key. */
  cacheKey: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
/** A turn as the caller asks for it, before the binding's defaults apply. */
export type TurnRequest = typeof TurnRequestSchema.Type;

const GoogleControlsSchema = Schema.Struct({
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  store: Schema.Boolean,
  thinkingLevel: ThinkingLevelSchema,
  toolChoice: ToolChoiceSchema,
});
const ResponsesControlsSchema = Schema.Struct({
  maxOutputTokens: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  temperature: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  ),
  store: Schema.Boolean,
  parallelToolCalls: Schema.Boolean,
  toolChoice: ToolChoiceSchema,
  reasoning: ResponsesReasoningSchema,
  serviceTier: Schema.NullOr(Schema.Literal('fast')),
  promptCacheKey: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
// API version 2026-10-21 refuses sampling parameters on every model, and the
// current models refuse a forced tool, so neither is representable here.
const AnthropicControlsSchema = Schema.Struct({
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  parallelToolCalls: Schema.Boolean,
  toolChoice: Schema.Literal('auto'),
  thinking: AnthropicThinkingSchema,
  effort: EffortSchema,
  cache: CacheSchema,
  stopSequences: Schema.Array(Schema.String),
});
const EditorControlsSchema = Schema.Struct({
  justification: Schema.String,
  toolChoice: Schema.Literal('auto'),
});

/** Schema check: a route without temperature support must default to null. */
function validateTemperatureDefault(configuration: {
  readonly supportsTemperature: boolean;
  readonly defaults: { readonly temperature: number | null };
}): Schema.FilterIssue[] {
  return !configuration.supportsTemperature &&
    configuration.defaults.temperature !== null
    ? [
        {
          path: ['defaults', 'temperature'],
          issue: 'A model without temperature support requires a null default.',
        },
      ]
    : [];
}

/** The editor's model: its binding and defaults, which the editor host serves. */
export const VscodeLanguageModelConfigurationSchema =
  EditorBindingSchema.mapFields(
    Struct.assign({
      protocol: Schema.Literal('vscode-lm'),
      supportsImageInput: Schema.Boolean,
      supportsToolCalling: Schema.Boolean,
      defaults: EditorControlsSchema.mapFields(Struct.omit(['toolChoice'])),
    }),
  );

/** A protocol binding and its defaults, as `bindModel` builds it (or the editor host). */
const ModelConfigurationSchema = Schema.Union([
  VscodeLanguageModelConfigurationSchema,
  BindingSchema.mapFields(
    Struct.assign({
      protocol: Schema.Literal('google-interactions'),
      background: BackgroundCapabilitySchema,
      defaults: GoogleControlsSchema.mapFields(Struct.omit(['toolChoice'])),
    }),
  ),
  BindingSchema.mapFields(
    Struct.assign({
      protocol: Schema.Literal('openai-responses'),
      background: BackgroundCapabilitySchema,
      supportsTemperature: Schema.Boolean,
      supportsMaxOutputTokens: Schema.Boolean,
      supportsStorage: Schema.Boolean,
      /** The route takes input files; a document is refused locally otherwise. */
      supportsDocumentInput: Schema.Boolean,
      webSocketStreamParameter: Schema.Literals(['implicit', 'required']),
      allowedReasoningEfforts: Schema.Array(ReasoningEffortLevelSchema),
      instructions: Schema.Union([
        Schema.Struct({ kind: Schema.Literal('optional') }),
        Schema.Struct({
          kind: Schema.Literal('required'),
          fallback: Schema.String.check(
            Schema.makeFilter((value) => value.trim().length > 0, {
              message: 'Required instructions need a nonblank fallback.',
            }),
          ),
        }),
      ]),
      /**
       * A chained request carries no `instructions`: the route reuses the
       * stored response's own and refuses both together (xAI). The prefix
       * fingerprint already pins the system prompt a continuation covers.
       */
      continuationInheritsInstructions: Schema.Boolean,
      /** The route takes `tool_choice` naming one function, not only `auto`. */
      supportsForcedToolChoice: Schema.Boolean,
      /** OpenAI's own endpoint (the API or the ChatGPT subscription): it routes
       *  its prompt cache by `prompt_cache_key` and takes mid-conversation
       *  `developer` messages. */
      openaiEndpoint: Schema.Boolean,
      /**
       * `openai` sends OpenAI's full request surface; `compatible` omits what
       * the vendor Responses endpoints do not take: the encrypted-reasoning
       * `include`, `strict` on tools, and a `store` that is only the default.
       */
      requestDialect: Schema.Literals(['openai', 'compatible']),
      defaults: ResponsesControlsSchema.mapFields(
        Struct.omit(['toolChoice', 'promptCacheKey']),
      ),
    }),
  ).check(
    Schema.makeFilter((configuration) => {
      const issues = validateTemperatureDefault(configuration);
      if (
        !configuration.supportsMaxOutputTokens &&
        configuration.defaults.maxOutputTokens !== null
      ) {
        issues.push({
          path: ['defaults', 'maxOutputTokens'],
          issue:
            'A protocol without output-limit support requires a null default.',
        });
      }
      if (!configuration.supportsStorage && configuration.defaults.store) {
        issues.push({
          path: ['defaults', 'store'],
          issue: 'A protocol without persistent storage requires store:false.',
        });
      }
      const effort = configuration.defaults.reasoning?.effort;
      if (
        effort != null &&
        !configuration.allowedReasoningEfforts.includes(effort)
      ) {
        issues.push({
          path: ['defaults', 'reasoning', 'effort'],
          issue: 'The default reasoning effort must be allowed by the route.',
        });
      }
      return issues;
    }),
  ),
  BindingSchema.mapFields(
    Struct.assign({
      protocol: Schema.Literal('anthropic-messages'),
      /** The model takes mid-conversation `role: "system"` messages. */
      supportsSystemMessages: Schema.Boolean,
      defaults: AnthropicControlsSchema.mapFields(Struct.omit(['toolChoice'])),
    }),
  ),
]);
export type ModelConfiguration = typeof ModelConfigurationSchema.Type;
/** The configuration a binding was built with; a mismatch is a programming defect. */
export const decodeModelConfiguration = Schema.decodeUnknownSync(
  ModelConfigurationSchema,
);
type ConfigurationOf<P> = Extract<ModelConfiguration, { protocol: P }>;
export type GoogleInteractionsConfiguration =
  ConfigurationOf<'google-interactions'>;
export type OpenAIResponsesConfiguration = ConfigurationOf<'openai-responses'>;
export type AnthropicMessagesConfiguration =
  ConfigurationOf<'anthropic-messages'>;
/** The editor's model configuration, as the editor host serves it. */
export type VscodeLanguageModelConfiguration =
  (typeof VscodeLanguageModelConfigurationSchema)['Type'];

const PreparedInputSchema = OriginSchema.mapFields(
  Struct.assign({
    mode: Schema.Literal('foreground'),
    system: Schema.optional(Schema.String),
    messages: PreparedHistorySchema,
    tools: ToolDefinitionsSchema,
  }),
);
const ResponsesPreparedSchema = PreparedInputSchema.mapFields(
  Struct.assign({
    protocol: Schema.Literal('openai-responses'),
    controls: ResponsesControlsSchema,
    continuation: Schema.optional(ResponsesContinuationSchema),
  }),
);
const GooglePreparedSchema = PreparedInputSchema.mapFields(
  Struct.assign({
    protocol: Schema.Literal('google-interactions'),
    controls: GoogleControlsSchema,
    continuation: Schema.optional(GoogleContinuationSchema),
  }),
);
const HttpTransportSchema = Schema.Struct({ kind: Schema.Literal('http') });
/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = Schema.Union([
  Schema.Union([
    EditorOriginSchema.mapFields(
      Struct.assign({
        ...PreparedInputSchema.mapFields(
          Struct.pick(['mode', 'system', 'messages', 'tools']),
        ).fields,
        // An editor object acquisition is not an account or durable origin identity.
        acquisitionId: Schema.String.check(Schema.isUUID()),
        controls: EditorControlsSchema,
      }),
    ),
    GooglePreparedSchema,
    ResponsesPreparedSchema.mapFields(
      Struct.assign({
        transport: Schema.Union([
          HttpTransportSchema,
          Schema.Struct({
            kind: Schema.Literal('websocket'),
            connectionId: Schema.String.check(Schema.isUUID()),
          }),
        ]),
      }),
    ),
    PreparedInputSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('anthropic-messages'),
        controls: AnthropicControlsSchema,
      }),
    ),
  ]),
  Schema.Union([
    ResponsesPreparedSchema.mapFields(
      Struct.assign({
        mode: Schema.Literal('background'),
        transport: HttpTransportSchema,
      }),
    ),
    GooglePreparedSchema.mapFields(
      Struct.assign({ mode: Schema.Literal('background') }),
    ),
  ]),
]);
/** A prepared turn: the request with the binding's controls fixed. */
export type ResolvedTurn = typeof ResolvedTurnSchema.Type;

/** A turn's token counts as the provider reported them, with the counts only
 *  one provider reports kept under its own name; an unknown count stays null. */
const TurnUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(CountSchema),
  outputTokens: Schema.NullOr(CountSchema),
  totalTokens: Schema.NullOr(CountSchema),
  cachedInputTokens: Schema.NullOr(CountSchema),
  reasoningTokens: Schema.NullOr(CountSchema),
  providerUsage: Schema.optional(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('google'),
        /** Reported tool-use prompt count; absence does not mean zero. */
        toolUsePromptTokens: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('xai'),
        costInUsdTicks: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('anthropic'),
        uncachedInputTokens: Schema.NullOr(CountSchema),
        cacheCreationTokens: Schema.NullOr(CountSchema),
        cacheCreation5mTokens: Schema.NullOr(CountSchema),
        cacheCreation1hTokens: Schema.NullOr(CountSchema),
      }),
    ]),
  ),
});
/** {@link TurnUsageSchema}'s value. */
export type TurnUsage = typeof TurnUsageSchema.Type;

const IdentitySchema = Schema.Struct({
  providerResponseId: Schema.String.check(Schema.isMinLength(1)),
  requestedOrigin: OriginSchema,
  returnedModel: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
});

const HttpTurnResultSchema = Schema.Struct({
  kind: Schema.Literal('http'),
  ...IdentitySchema.fields,
  /** Null for a stateless Google response with no retrievable ID. */
  providerResponseId: Schema.NullOr(IdentitySchema.fields.providerResponseId),
  modelFingerprint: Schema.NullOr(Schema.String),
  content: ContentSchema,
  finishReason: Schema.Literals([
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'stop-sequence',
    'refusal',
    'context-window-exceeded',
  ]),
  stopSequence: Schema.optional(Schema.String),
  finishEvidence: Schema.optional(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('google-interactions'),
        // Preserve Google's open status vocabulary verbatim.
        status: Schema.String.check(Schema.isMinLength(1)),
        // Google currently reports no terminal reason.
        terminalReason: Schema.NullOr(
          Schema.String.check(Schema.isMinLength(1)),
        ),
      }),
      Schema.Struct({
        kind: Schema.Literal('openai-responses'),
        status: Schema.Literals([
          'queued',
          'in_progress',
          'completed',
          'failed',
          'cancelled',
          'incomplete',
        ]),
        // Present only on an incomplete response.
        incompleteReason: Schema.NullOr(
          Schema.Literals(['max_output_tokens', 'content_filter']),
        ),
      }),
    ]),
  ),
  refusalEvidence: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literal('anthropic-refusal'),
        category: Schema.NullOr(
          Schema.Literals([
            'cyber',
            'bio',
            'frontier_llm',
            'reasoning_extraction',
            'general_harms',
          ]),
        ),
        explanation: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  /** Unknown counts remain unknown, including within a partial receipt. */
  usage: Schema.NullOr(TurnUsageSchema),
  continuation: Schema.optional(ContinuationSchema),
}).check(
  Schema.makeFilter((result) => {
    const issues = validateAssistantContent(
      result.requestedOrigin,
      result.content,
    );
    if (
      (result.finishReason === 'stop-sequence') !==
      (result.stopSequence !== undefined)
    ) {
      issues.push({
        path: ['stopSequence'],
        issue:
          'A stop-sequence outcome requires its exact matched sequence, and no other outcome has one.',
      });
    }
    const usageKind = result.usage?.providerUsage?.kind;
    const finishKind = result.finishEvidence?.kind;
    if (
      (result.providerResponseId === null &&
        (result.requestedOrigin.protocol !== 'google-interactions' ||
          result.continuation !== undefined)) ||
      (result.refusalEvidence !== undefined &&
        result.requestedOrigin.protocol !== 'anthropic-messages') ||
      (result.refusalEvidence != null && result.finishReason !== 'refusal') ||
      (usageKind != null &&
        result.requestedOrigin.protocol !== EVIDENCE_PROTOCOL[usageKind]) ||
      (finishKind != null &&
        result.requestedOrigin.protocol !== EVIDENCE_PROTOCOL[finishKind])
    ) {
      issues.push(
        'Provider identity and evidence require their original protocol and outcome.',
      );
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
      issues.push({
        path: ['content'],
        issue: 'Incomplete provider items require an incomplete turn outcome.',
      });
    }
    if (
      result.continuation &&
      !sameModelOrigin(result.requestedOrigin, result.continuation.origin)
    ) {
      issues.push({
        path: ['continuation'],
        issue: 'Continuation belongs to another model origin.',
      });
    }
    return issues;
  }),
);
const EditorTurnResultSchema = Schema.Struct({
  kind: Schema.Literal('editor'),
  requestedOrigin: EditorOriginSchema,
  // Normal editor EOF reports none of these provider facts.
  providerResponseId: Schema.Null,
  returnedModel: Schema.Null,
  modelFingerprint: Schema.Null,
  finishReason: Schema.Null,
  usage: Schema.Null,
  content: EditorContentSchema,
}).check(
  Schema.makeFilter((result) =>
    validateAssistantContent(result.requestedOrigin, result.content),
  ),
);
/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = Schema.Union([
  HttpTurnResultSchema,
  EditorTurnResultSchema,
]);
/** A completed provider turn: its content, finish reason and usage. */
export type TurnResult = typeof TurnResultSchema.Type;

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
const IdentifiedEventSchema = IdentitySchema.mapFields(
  Struct.assign({ kind: Schema.Literal('identified') }),
);
const DeltaEventSchema = Schema.Struct({
  kind: Schema.Literal('delta'),
  part: Schema.Literals(['text', 'refusal', 'reasoning']),
  text: Schema.String,
});
const CompletedEventSchema = Schema.Struct({
  kind: Schema.Literal('completed'),
  result: TurnResultSchema,
});
const HttpCompletedEventSchema = CompletedEventSchema.mapFields(
  Struct.assign({ result: HttpTurnResultSchema }),
);
/** A streamed turn's event as data, as an editor's model sends it over. */
export const TurnEventSchema = Schema.Union([
  IdentifiedEventSchema,
  DeltaEventSchema,
  CompletedEventSchema,
]);
/** A streamed turn's event: its identity, a text delta, or the result. */
export type TurnEvent = typeof TurnEventSchema.Type;

/** A submission's answer: the accepted operation, or the finished turn. */
export const BackgroundSubmissionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('accepted'),
    operation: RemoteOperationSchema,
    returnedModel: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  }),
  HttpCompletedEventSchema,
]);
/** {@link BackgroundSubmissionSchema}'s value. */
export type BackgroundSubmission = typeof BackgroundSubmissionSchema.Type;
const SequenceSchema = Schema.Struct({
  afterSequence: CountSchema,
});
/** A delivered sequence is not a durable acknowledgement by its consumer. */
const SequencedBackgroundEventSchema = Schema.Union([
  IdentifiedEventSchema.mapFields(
    Struct.assign({
      ...SequenceSchema.fields,
      requestedOrigin: OriginSchema.mapFields(
        Struct.assign({ protocol: Schema.Literal('openai-responses') }),
      ),
    }),
  ),
  DeltaEventSchema.mapFields(Struct.assign(SequenceSchema.fields)),
  HttpCompletedEventSchema.mapFields(
    Struct.assign({
      ...SequenceSchema.fields,
      result: HttpTurnResultSchema.check(
        Schema.makeFilter(
          (result) => result.requestedOrigin.protocol === 'openai-responses',
        ),
      ),
    }),
  ),
  SequenceSchema.mapFields(Struct.assign({ kind: Schema.Literal('cursor') })),
]);
/** Polling can report identity and completion, but cannot invent stream progress. */
export const BackgroundEventSchema = Schema.Union([
  SequencedBackgroundEventSchema,
  IdentifiedEventSchema.mapFields(
    Struct.assign({
      afterSequence: Schema.Null,
      requestedOrigin: OriginSchema.mapFields(
        Struct.assign({ protocol: Schema.Literal('google-interactions') }),
      ),
    }),
  ),
  HttpCompletedEventSchema.mapFields(
    Struct.assign({
      afterSequence: Schema.Null,
      result: HttpTurnResultSchema.check(
        Schema.makeFilter(
          (result) => result.requestedOrigin.protocol === 'google-interactions',
        ),
      ),
    }),
  ),
]);
/** An event of observed background work; polling reports no sequence. */
export type BackgroundEvent = typeof BackgroundEventSchema.Type;
/** Absolute original deadline; reconnecting does not replenish it. */
export const ObservationPolicySchema = Schema.Struct({
  deadlineAtMs: CountSchema,
});

/** The bytes an upload takes. */
export const FileUploadSchema = Schema.Struct({
  mimeType: Schema.String.check(Schema.isMinLength(1)),
  filename: Schema.String.check(Schema.isMinLength(1)),
  base64: Schema.String.check(Schema.isBase64()),
});
/** {@link FileUploadSchema}'s value. */
export type FileUpload = typeof FileUploadSchema.Type;

/**
 * The lifetime every upload asks its provider for, in seconds: one day, long
 * enough for a typical run and inside both files endpoints' accepted range
 * (OpenAI `expires_after.seconds` 3600-2592000, Anthropic
 * `expires_in_seconds` 3600-7776000, per the pinned SDK typings). Without it
 * OpenAI keeps a non-batch file until deleted. A binding deletes its uploads
 * when its scope closes; this bound clears what a crashed process left.
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
  readonly background?: {
    submit(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
    ): Effect.Effect<BackgroundSubmission, ModelError>;
    /**
     * Observe remote work against the exact turn recorded at submission.
     * Its completion anchors to that turn's history; the operation handle
     * deliberately carries no duplicate transcript.
     */
    observe(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
      operation: RemoteOperation,
      policy: typeof ObservationPolicySchema.Type,
    ): Stream.Stream<BackgroundEvent, ModelError>;
    /** Cancel the work; fails unless the provider confirms it stopped. */
    cancel(operation: RemoteOperation): Effect.Effect<void, ModelError>;
  };
}

/** A foreground turn's completed result: the fold over `streamTurn`'s events. */
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
