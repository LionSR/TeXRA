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
  CountSchema,
  JsonObjectSchema,
  ModelOriginSchema,
  sameModelOrigin,
  TurnUsageSchema,
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

const ToolChoiceSchema = Schema.Union([
  Schema.Literal('auto'),
  Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }),
]);
// The turn contract spells efforts in its own literals, not llm-zoo's
// `ReasoningEffort` enum; the enum is checked against them by assignment in
// the configuration builders (`api/configuration.ts`).
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
    summary: Schema.NullOr(Schema.Literal('auto')),
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
/** The thinking levels Google's Interactions request takes. */
export const ThinkingLevelSchema = Schema.Literals([
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
  /** This turn's output ceiling in place of the binding's; a route that
   *  takes no output limit ignores it. */
  maxOutputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
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
  toolChoice: ToolChoiceSchema,
  reasoning: ResponsesReasoningSchema,
  serviceTier: Schema.NullOr(Schema.Literal('fast')),
  promptCacheKey: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
// API version 2026-10-21 refuses sampling parameters on every model, and the
// current models refuse a forced tool, so neither is representable here.
const AnthropicControlsSchema = Schema.Struct({
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  toolChoice: Schema.Literal('auto'),
  thinking: AnthropicThinkingSchema,
  effort: EffortSchema,
  cache: CacheSchema,
});
/**
 * A protocol binding and its defaults, as `bindModel` builds it; never
 * decoded, so it states the shape only. A null default `temperature` or
 * `maxOutputTokens` is a route that takes none.
 */
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
      /** The route takes input files; a document is refused locally otherwise. */
      supportsDocumentInput: Schema.Boolean,
      allowedReasoningEfforts: Schema.Array(ReasoningEffortLevelSchema),
      /**
       * A chained request carries no `instructions`: the route reuses the
       * stored response's own and refuses both together (xAI). The prefix
       * fingerprint already pins the system prompt a continuation covers.
       */
      continuationInheritsInstructions: Schema.Boolean,
      /** The route takes `tool_choice` naming one function, not only `auto`. */
      supportsForcedToolChoice: Schema.Boolean,
      /** OpenAI's own endpoint (the API or a ChatGPT plan): it routes its prompt
       *  cache by `prompt_cache_key` and takes `developer` messages mid-run. */
      openaiEndpoint: Schema.Boolean,
      /**
       * `openai` sends OpenAI's full request surface; `chatgpt` sends it with
       * function tools inside the plan's namespace; `compatible` omits what
       * the vendor Responses endpoints do not take: the encrypted-reasoning
       * `include`, `strict` on tools, and a `store` that is only the default.
       */
      requestDialect: Schema.Literals(['openai', 'compatible', 'chatgpt']),
      defaults: ResponsesControlsSchema.mapFields(
        Struct.omit(['toolChoice', 'promptCacheKey']),
      ),
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
type ConfigurationOf<P> = Extract<ModelConfiguration, { protocol: P }>;
export type GoogleInteractionsConfiguration =
  ConfigurationOf<'google-interactions'>;
export type OpenAIResponsesConfiguration = ConfigurationOf<'openai-responses'>;
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
/** Prepared semantic input; execution never reapplies current defaults. */
export const ResolvedTurnSchema = Schema.Union([
  Schema.Union([
    GooglePreparedSchema,
    ResponsesPreparedSchema,
    PreparedInputSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('anthropic-messages'),
        controls: AnthropicControlsSchema,
      }),
    ),
  ]),
  Schema.Union([
    ResponsesPreparedSchema.mapFields(
      Struct.assign({ mode: Schema.Literal('background') }),
    ),
    GooglePreparedSchema.mapFields(
      Struct.assign({ mode: Schema.Literal('background') }),
    ),
  ]),
]);
/** A prepared turn: the request with the binding's controls fixed. */
export type ResolvedTurn = typeof ResolvedTurnSchema.Type;

const IdentitySchema = Schema.Struct({
  providerResponseId: Schema.String.check(Schema.isMinLength(1)),
  requestedOrigin: ModelOriginSchema,
  returnedModel: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
});

/*
 * Provider words a turn's evidence keeps as the provider spelled them. The
 * wire schemas decode with these same sets, so a turn and the wire it came
 * from cannot disagree; they live here, in the contract both import, so the
 * browser-safe root entry carries no wire module.
 */
/** A Responses API response's status. */
export const ResponsesStatusSchema = Schema.Literals([
  'queued',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'incomplete',
]);
/** Why a Responses API response is incomplete. */
export const ResponsesIncompleteReasonSchema = Schema.Literals([
  'max_output_tokens',
  'content_filter',
]);
/** The category of an Anthropic Messages refusal. */
export const AnthropicRefusalCategorySchema = Schema.Literals([
  'cyber',
  'bio',
  'frontier_llm',
  'reasoning_extraction',
  'general_harms',
]);

/** A completed provider turn, not a completed agent execution. */
export const TurnResultSchema = Schema.Struct({
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
    'refusal',
  ]),
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
        status: ResponsesStatusSchema,
        // Present only on an incomplete response.
        incompleteReason: Schema.NullOr(ResponsesIncompleteReasonSchema),
      }),
    ]),
  ),
  refusalEvidence: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literal('anthropic-refusal'),
        category: Schema.NullOr(AnthropicRefusalCategorySchema),
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
    returnedModel: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  }),
  CompletedEventSchema,
]);
/** {@link BackgroundSubmissionSchema}'s value. */
export type BackgroundSubmission = typeof BackgroundSubmissionSchema.Type;
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
     * deliberately carries no duplicate transcript. A polled operation
     * reports only its identity and its completion; a streamed one also
     * reports deltas.
     */
    observe(
      turn: Extract<ResolvedTurn, { mode: 'background' }>,
      operation: RemoteOperation,
      policy: typeof ObservationPolicySchema.Type,
    ): Stream.Stream<TurnEvent, ModelError>;
    /** Cancel the work; fails unless the provider confirms it stopped. */
    cancel(operation: RemoteOperation): Effect.Effect<void, ModelError>;
  };
}

/** A foreground turn's completed result: assembled from `streamTurn`'s events. */
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
      kind: 'provider-rejection',
      message: 'The model stream produced no completed result.',
    });
  return result;
});
