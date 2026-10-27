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
  JsonObjectSchema,
  ModelOriginSchema,
  sameModelOrigin,
} from './protocol.js';

// Local imports - canonical messages
import {
  ContentSchema,
  ContinuationSchema,
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
  name: Schema.NonEmptyString,
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
  Schema.Struct({ name: Schema.NonEmptyString }),
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
  cacheKey: Schema.optional(Schema.NonEmptyString),
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
  promptCacheKey: Schema.optional(Schema.NonEmptyString),
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
const ModelConfigurationSchema = Schema.Union([
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
      const issues: Schema.FilterIssue[] = [];
      if (
        !configuration.supportsTemperature &&
        configuration.defaults.temperature !== null
      ) {
        issues.push({
          path: ['defaults', 'temperature'],
          issue: 'A model without temperature support requires a null default.',
        });
      }
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
/** A protocol binding and its defaults, as `bindModel` builds it. */
export type ModelConfiguration = typeof ModelConfigurationSchema.Type;
/** The configuration a binding was built with; a mismatch is a programming defect. */
export const decodeModelConfiguration = Schema.decodeUnknownSync(
  ModelConfigurationSchema,
);
type ConfigurationOf<P> = Extract<ModelConfiguration, { protocol: P }>;
/** A Google Interactions binding's configuration. */
export type GoogleInteractionsConfiguration =
  ConfigurationOf<'google-interactions'>;
/** An OpenAI Responses binding's configuration (OpenAI and the vendors on it). */
export type OpenAIResponsesConfiguration = ConfigurationOf<'openai-responses'>;
/** An Anthropic Messages binding's configuration. */
export type AnthropicMessagesConfiguration =
  ConfigurationOf<'anthropic-messages'>;
const PreparedInputSchema = ModelOriginSchema.mapFields(
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
  providerResponseId: Schema.NonEmptyString,
  requestedOrigin: ModelOriginSchema,
  returnedModel: Schema.NullOr(Schema.NonEmptyString),
});

const TurnResultFieldsSchema = Schema.Struct({
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
        status: Schema.NonEmptyString,
        // Google currently reports no terminal reason.
        terminalReason: Schema.NullOr(Schema.NonEmptyString),
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
});
type TurnResultFields = typeof TurnResultFieldsSchema.Type;

/** Identity or evidence on a result that its protocol or outcome cannot carry. */
function misplacedIdentityOrEvidence(result: TurnResultFields): boolean {
  const { protocol } = result.requestedOrigin;
  return (
    (result.providerResponseId === null &&
      (protocol !== 'google-interactions' ||
        result.continuation !== undefined)) ||
    (result.refusalEvidence !== undefined &&
      protocol !== 'anthropic-messages') ||
    (result.refusalEvidence != null && result.finishReason !== 'refusal') ||
    [result.usage?.providerUsage?.kind, result.finishEvidence?.kind].some(
      (kind) => kind != null && protocol !== EVIDENCE_PROTOCOL[kind],
    )
  );
}

/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = TurnResultFieldsSchema.check(
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
    if (misplacedIdentityOrEvidence(result)) {
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
/** A streamed turn's event as data. */
const TurnEventSchema = Schema.Union([
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
    returnedModel: Schema.NullOr(Schema.NonEmptyString),
  }),
  CompletedEventSchema,
]);
/** {@link BackgroundSubmissionSchema}'s value. */
export type BackgroundSubmission = typeof BackgroundSubmissionSchema.Type;
const SequenceSchema = Schema.Struct({ afterSequence: CountSchema });
/** A delivered sequence is not a durable acknowledgement by its consumer. */
const SequencedBackgroundEventSchema = Schema.Union([
  IdentifiedEventSchema.mapFields(
    Struct.assign({
      ...SequenceSchema.fields,
      requestedOrigin: ModelOriginSchema.mapFields(
        Struct.assign({ protocol: Schema.Literal('openai-responses') }),
      ),
    }),
  ),
  DeltaEventSchema.mapFields(Struct.assign(SequenceSchema.fields)),
  CompletedEventSchema.mapFields(
    Struct.assign({
      ...SequenceSchema.fields,
      result: TurnResultSchema.check(
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
      requestedOrigin: ModelOriginSchema.mapFields(
        Struct.assign({ protocol: Schema.Literal('google-interactions') }),
      ),
    }),
  ),
  CompletedEventSchema.mapFields(
    Struct.assign({
      afterSequence: Schema.Null,
      result: TurnResultSchema.check(
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
  mimeType: Schema.NonEmptyString,
  filename: Schema.NonEmptyString,
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
    (): TurnResult | null => null,
    (current, event) => (event.kind === 'completed' ? event.result : current),
  );
  if (result === null)
    return yield* new ModelError({
      kind: 'malformed-output',
      message: 'The model stream produced no completed result.',
    });
  return result;
});
