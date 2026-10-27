# `@texra-ai/llm`

<!-- Generated from `packages/llm/src/index.ts` by `npm run docgen`; do not edit. -->

## acceptedEfforts

The effort values a route may send for a model: the levels it accepts
while thinking, plus `none` where `none` is how thinking is turned off.

```ts
function acceptedEfforts(
  config: Pick<ModelConfig, 'reasoning'>,
): ReasoningEffort[]
```

## API_KEY_ENV_NAMES

Every environment variable read as a provider API key, derived from the
provider manifest, so a provider added there is covered here: what a host
keeps out of a child process's environment, for one.

```ts
const API_KEY_ENV_NAMES: readonly string[]
```

## API_KEY_PROVIDER_IDS

Provider IDs where users can configure direct API keys — the single source
for direct key-provider enumeration. Order = display order in the settings
key rows.

```ts
const API_KEY_PROVIDER_IDS: readonly ApiKeyProviderId[]
```

## apiKeyEnvName

Environment variable for a provider's API key.

```ts
function apiKeyEnvName(provider: ApiKeyProviderId): string
```

## ApiKeyProviderId

Ids of the providers users can configure a direct API key for.

```ts
type ApiKeyProviderId = Extract<
  (typeof MANIFEST)[number],
  { readonly apiKey: true }
>['id'];
```

## apiKeySecretName

Secret storage key for a provider's API key.

```ts
function apiKeySecretName(provider: ApiKeyProviderId): string
```

## ApiKeyStatus

UI-safe provider key status derived from a resolved API key origin.

```ts
type ApiKeyStatus = 'set' | 'env' | 'not-set';
```

## ApiKeyUsageRoute

What a direct provider key pays through.

```ts
type ApiKeyUsageRoute =
  'api-key' | 'kimi-code-subscription' | 'glm-coding-plan-subscription';
```

## apiProviderOfSecretName

The provider whose API key a secret-store entry holds, or `undefined` for
every other entry (OAuth tokens, the GitHub token). The
inverse of {@link apiKeySecretName}, for subscribers of the store's
`credentialChanged` signal.

```ts
function apiProviderOfSecretName(
  key: string,
): ApiKeyProviderId | undefined
```

## AssistantMessage

The content one turn produced, stamped with the turn's origin.

```ts
type AssistantMessage = typeof AssistantMessageSchema.Type;
```

## assistantMessageFromResult

The assistant message a completed turn contributes to canonical history.

```ts
function assistantMessageFromResult(
  result: TurnResult,
): AssistantMessage
```

## AssistantMessageSchema

The assistant message: a turn's content with its origin.

```ts
const AssistantMessageSchema: Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>
```

## BACKEND_PROTOCOLS

The protocol each provider a run's conversation can be bound to (its
backend) serves that conversation on, keyed by plugin id.

```ts
const BACKEND_PROTOCOLS: Readonly<{ openai: "openai-responses"; anthropic: "anthropic-messages"; google: "google-interactions"; xai: "openai-responses"; deepseek: "openai-responses"; moonshot: "openai-responses"; dashscope: "openai-responses"; minimax: "openai-responses"; glm: "openai-responses"; meta: "openai-responses"; }>
```

## BackendProviderId

A provider a run's conversation can be bound to: its backend.

```ts
type BackendProviderId = keyof typeof BACKEND_PROTOCOLS;
```

## BackgroundEvent

An event of observed background work; polling reports no sequence.

```ts
type BackgroundEvent = typeof BackgroundEventSchema.Type;
```

## BackgroundSubmission

{@link BackgroundSubmissionSchema}'s value.

```ts
type BackgroundSubmission = typeof BackgroundSubmissionSchema.Type;
```

## BillingRoute

The route a binding bills through: a plan, or the caller's API key.

```ts
type BillingRoute = PlanRoute | 'api-key';
```

## checkPreparedHistory

The history a turn sends: each assistant's local calls answered by the
next message, in call order. Only the next request needs them settled.
Returns the schema issues found, one per offending message.

```ts
function checkPreparedHistory(
  messages: readonly PreparedHistoryEntry[],
): Schema.FilterIssue[]
```

## chooseReasoning

Decide thinking, effort and mode for one request.

- The effort is the selection's, else the user's saved level, else
  {@link DEFAULT_EFFORT}.
- `none` turns thinking off; it is refused on a model that cannot stop
  thinking, as is thinking on a model that never thinks, because on/off
  changes the kind of answer, not its amount.
- Any other level the model lacks becomes the nearest level it has (ties
  go up), reported in `note`; `strict` refuses instead.

```ts
function chooseReasoning(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
  request: ReasoningRequest = {},
  options: ChooseReasoningOptions = {},
): ReasoningChoice
```

## ChooseReasoningOptions

How {@link chooseReasoning} settles a request the model cannot serve.

```ts
interface ChooseReasoningOptions {
  /** The user's saved level for this model, used when the selection names none. */
  readonly userEffort?: ReasoningEffort;
  /** A route's own ceiling on the levels it can serve (e.g. the Codex subscription backend). */
  readonly routeEfforts?: readonly ReasoningEffort[];
  /** Refuse instead of substituting a nearby level. */
  readonly strict?: boolean;
}
```

## CODEX_ROUTE_EFFORTS

The Codex subscription backend runs every turn synchronously on one
connection, so an effort above medium risks the client timing out before
it answers: a route ceiling, applied through the one reasoning policy.

```ts
const CODEX_ROUTE_EFFORTS: readonly ReasoningEffort[]
```

## codexBackendModelId

The model id the Codex backend keys on: the API `id` with its llm-zoo date
pin stripped.

Never the `shortName`. That is llm-zoo's display abbreviation, and for every
Codex-eligible model but one it happens to equal the backend slug — which is
why preferring it went unnoticed. The exception is the GPT-5.6 family, whose
members are `gpt-5.6-sol`, `-terra` and `-luna`: there is no bare `gpt-5.6`
model anywhere, but that is exactly the `shortName` llm-zoo gives Sol. We
sent it and the backend answered
`The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
account.` — a message that reads as a subscription problem and sends users
to check their plan, when the id was simply not a model.

```ts
function codexBackendModelId(
  config: Pick<ModelConfig, 'ref' | 'id'>,
): string
```

## completedTurn

A foreground turn's completed result: the fold over `streamTurn`'s events.

```ts
const completedTurn: (events: Stream<{ readonly kind: "completed"; readonly result: { readonly kind: "http"; readonly usage: { readonly reasoningTokens: number | null; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null; readonly cachedInputTokens: number | null; readonly providerUsage?: { readonly kind: "google"; readonly toolUsePromptTokens: number | null; } | { readonly kind: "xai"; readonly costInUsdTicks: number | null; } | { readonly kind: "anthropic"; readonly uncachedInputTokens: number | null; readonly cacheCreationTokens: number | null; readonly cacheCreation5mTokens: number | null; readonly cacheCreation1hTokens: number | null; } | undefined; } | null; readonly content: readonly ({ readonly kind: "message"; readonly content: readonly ({ readonly kind: "text"; readonly text: string; } | { readonly kind: "refusal"; readonly text: string; })[]; readonly evidence?: { readonly kind: "openai-responses-message"; readonly status: "completed" | "incomplete"; readonly itemId: string; readonly phase?: "commentary" | "final_answer" | null | undefined; } | undefined; } | { readonly kind: "reasoning"; readonly summary: readonly { readonly kind: "text"; readonly text: string; }[]; readonly evidence: { readonly kind: "google-interactions-thought-signature"; readonly signature: string; } | { readonly kind: "openai-responses-reasoning"; readonly itemId: string; readonly status?: "completed" | "incomplete" | undefined; readonly encryptedContent?: string | null | undefined; } | { readonly kind: "anthropic-thinking-signature"; readonly signature: string; } | { readonly kind: "anthropic-redacted-thinking"; readonly data: string; } | null; readonly content?: readonly { readonly kind: "text"; readonly text: string; }[] | undefined; } | { readonly kind: "local-call"; readonly name: string; readonly providerCallId: string; readonly argumentsText: string; readonly evidence?: { readonly kind: "openai-responses-function-call"; readonly status?: "completed" | undefined; readonly itemId?: string | undefined; } | undefined; })[]; readonly providerResponseId: string | null; readonly returnedModel: string | null; readonly modelFingerprint: string | null; readonly finishReason: "length" | "stop" | "refusal" | "content-filter" | "tool-calls" | "stop-sequence" | "context-window-exceeded"; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: 1; }; readonly stopSequence?: string | undefined; readonly finishEvidence?: { readonly kind: "google-interactions"; readonly status: string; readonly terminalReason: string | null; } | { readonly kind: "openai-responses"; readonly status: "completed" | "cancelled" | "failed" | "in_progress" | "queued" | "incomplete"; readonly incompleteReason: "max_output_tokens" | "content_filter" | null; } | undefined; readonly refusalEvidence?: { readonly kind: "anthropic-refusal"; readonly category: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null; readonly explanation: string | null; } | null | undefined; readonly continuation?: { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: 1; readonly protocol: "google-interactions"; }; readonly anchor: { readonly interactionId: string; readonly coveredSteps: number; }; } | { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: 1; readonly protocol: "openai-responses"; }; readonly anchor: { readonly responseId: string; readonly coveredItems: number; readonly kind: "stored"; }; } | undefined; }; } | { readonly providerResponseId: string; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: 1; }; readonly returnedModel: string | null; readonly kind: "identified"; } | { readonly kind: "delta"; readonly part: "text" | "refusal" | "reasoning"; readonly text: string; }, ModelError, never>) => Effect<{ readonly kind: "http"; readonly usage: { readonly reasoningTokens: number | null; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null; readonly cachedInputTokens: number | null; readonly providerUsage?: { readonly kind: "google"; readonly toolUsePromptTokens: number | null; } | { readonly kind: "xai"; readonly costInUsdTicks: number | null; } | { readonly kind: "anthropic"; readonly uncachedInputTokens: number | null; readonly cacheCreationTokens: number | null; readonly cacheCreation5mTokens: number | null; readonly cacheCreation1hTokens: number | null; } | undefined; } | null; readonly content: readonly ({ readonly kind: "message"; readonly content: readonly ({ readonly kind: "text"; readonly text: string; } | { readonly kind: "refusal"; readonly text: string; })[]; readonly evidence?: { readonly kind: "openai-responses-message"; readonly status: "completed" | "incomplete"; readonly itemId: string; readonly phase?: "commentary" | "final_answer" | null | undefined; } | undefined; } | { readonly kind: "reasoning"; readonly summary: readonly { readonly kind: "text"; readonly text: string; }[]; readonly evidence: { readonly kind: "google-interactions-thought-signature"; readonly signature: string; } | { readonly kind: "openai-responses-reasoning"; readonly itemId: string; readonly status?: "completed" | "incomplete" | undefined; readonly encryptedContent?: string | null | undefined; } | { readonly kind: "anthropic-thinking-signature"; readonly signature: string; } | { readonly kind: "anthropic-redacted-thinking"; readonly data: string; } | null; readonly content?: readonly { readonly kind: "text"; readonly text: string; }[] | undefined; } | { readonly kind: "local-call"; readonly name: string; readonly providerCallId: string; readonly argumentsText: string; readonly evidence?: { readonly kind: "openai-responses-function-call"; readonly status?: "completed" | undefined; readonly itemId?: string | undefined; } | undefined; })[]; readonly providerResponseId: string | null; readonly returnedModel: string | null; readonly modelFingerprint: string | null; readonly finishReason: "length" | "stop" | "refusal" | "content-filter" | "tool-calls" | "stop-sequence" | "context-window-exceeded"; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: 1; }; readonly stopSequence?: string | undefined; readonly finishEvidence?: { readonly kind: "google-interactions"; readonly status: string; readonly terminalReason: string | null; } | { readonly kind: "openai-responses"; readonly status: "completed" | "cancelled" | "failed" | "in_progress" | "queued" | "incomplete"; readonly incompleteReason: "max_output_tokens" | "content_filter" | null; } | undefined; readonly refusalEvidence?: { readonly kind: "anthropic-refusal"; readonly category: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null; readonly explanation: string | null; } | null | undefined; readonly continuation?: { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: 1; readonly protocol: "google-interactions"; }; readonly anchor: { readonly interactionId: string; readonly coveredSteps: number; }; } | { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: 1; readonly protocol: "openai-responses"; }; readonly anchor: { readonly responseId: string; readonly coveredItems: number; readonly kind: "stored"; }; } | undefined; }, ModelError, never>
```

## Continuation

{@link ContinuationSchema}'s value.

```ts
type Continuation = typeof ContinuationSchema.Type;
```

## CredentialOrigin

Where a resolved credential came from.

```ts
type CredentialOrigin = 'secret' | 'env' | 'none';
```

## CredentialStore

A store of named secrets. Every member is an `Effect`, so a credential read
is interruptible like the program around it and its failure is typed. The
host's store owns its write semantics (a commit that survives
cancellation, the change signal it publishes).

```ts
interface CredentialStore {
  /** The persisted secret under a name, or `undefined`. */
  get(name: string): Effect.Effect<string | undefined, SecretsFailed>;
  set(name: string, value: string): Effect.Effect<void, SecretsFailed>;
  delete(name: string): Effect.Effect<void, SecretsFailed>;
}
```

## decideModelRoute

Decide the route `config` takes under `facts`. Pure.

```ts
function decideModelRoute(
  config: ModelConfig,
  facts: RouteDecisionFacts,
): ModelRoute
```

## defaultReasoningLevel

The level a run uses for this model when nothing names one: `none` when it
does not think by default, `undefined` when it thinks without levels.

```ts
function defaultReasoningLevel(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
): ReasoningEffort | undefined
```

## EndpointProviderId

Providers with an HTTP endpoint of their own, which a host may override.

```ts
type EndpointProviderId = Extract<
  (typeof MANIFEST)[number],
  { readonly baseUrl: string | RegionalBaseUrl }
>['id'];
```

## FileUpload

{@link FileUploadSchema}'s value.

```ts
type FileUpload = typeof FileUploadSchema.Type;
```

## findModelProviderPlugin

Look up a provider plugin by id.

```ts
function findModelProviderPlugin(
  id: string,
): ModelProviderPlugin | undefined
```

## hasUsableApiKey

Check whether a usable API key is resolved for a provider (secret storage,
then environment, both trimmed and blank-filtered by `resolveCredential`).
This is the existence check every host shares.

```ts
function hasUsableApiKey(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<boolean, SecretsFailed>
```

## HostRouteFacts

The host half of {@link RouteFacts}, shared by every model.

```ts
type HostRouteFacts = Omit<RouteFacts, 'validation'>;
```

## isApiProvider

Runtime-checked narrowing for provider strings.

```ts
function isApiProvider(provider: string): provider is ApiKeyProviderId
```

## isKimiCodeExclusiveModel

Whether the coding endpoint ALONE serves `model`: llm-zoo pins its `baseUrl`
there, so no open-platform route exists.

```ts
function isKimiCodeExclusiveModel(
  model: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean
```

## isKimiSubscriptionEligible

Whether the Kimi Code coding endpoint serves `model`: the llm-zoo
`kimiSubscription` flag on a Moonshot model. Serving status is a fact about
the Kimi Code backend, not derivable from other model fields.

```ts
function isKimiSubscriptionEligible(
  model: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean
```

## isUnservedModel

Whether no route TeXRA reaches serves `config`: llm-zoo retired the model,
or only OpenRouter serves it, which TeXRA does not call.

```ts
function isUnservedModel(
  config: Pick<ModelConfig, 'retired' | 'openRouterOnly'>,
): boolean
```

## JsonObjectSchema

Materialized JSON: a string-keyed object of JSON values.

```ts
const JsonObjectSchema: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>
```

## loadApiKeyStatusMap

Every API-key provider's status, from its resolved key origin.

```ts
function loadApiKeyStatusMap(
  credentials: CredentialStore,
): Effect.Effect<Record<ApiKeyProviderId, ApiKeyStatus>, SecretsFailed>
```

## lookupApiKey

The key's value, or `undefined` if absent. It and {@link lookupApiKeyOrigin}
share one {@link resolveApiKey} pass over secret storage then the env var.
Both are programs: a caller yields one and matches {@link SecretsFailed}
instead of catching `unknown` from a rejected read.

```ts
function lookupApiKey(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<Redacted.Redacted<string> | undefined, SecretsFailed>
```

## lookupApiKeyOrigin

Origin of the resolved key (`secret` / `env` / `none`).

```ts
function lookupApiKeyOrigin(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<CredentialOrigin, SecretsFailed>
```

## MessageSchema

One message of the history a turn sends (user, assistant, tool, system).

```ts
const MessageSchema: Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>
```

## Model

A configured executable value; it owns neither conversation nor retry policy.

```ts
interface Model {
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
```

## MODEL_PROVIDER_PLUGINS

Every model provider plugin, in display order.

```ts
const MODEL_PROVIDER_PLUGINS: readonly ModelProviderPlugin[]
```

## modelConfig

The registry entry a stored model string names.

```ts
function modelConfig(id: string): ModelConfig | undefined
```

## ModelError

Typed provider failure. Fiber interruption remains outside this channel.
`retryable` and `scope` default from the kind and status; the binding that
read the vendor's reply states them where the reply says more. The local
`cause` rides as `Error.cause`, outside the wire fields.

```ts
class ModelError extends Schema.TaggedError<ModelError>()('ModelError', {
  ...ModelErrorFieldsSchema.fields,
  cause: Schema.optional(Schema.Defect()),
})
```

## ModelErrorFields

A {@link ModelError}'s fields: the wire fields and the local `cause`.

```ts
type ModelErrorFields = typeof ModelErrorFieldsSchema.Type & {
  readonly cause?: unknown;
};
```

## ModelOrigin

The binding a turn was requested on: model, deployment and protocol.

```ts
type ModelOrigin = typeof ModelOriginSchema.Type;
```

## ModelOriginSchema

Selected binding, distinct from an optional returned model version.

```ts
const ModelOriginSchema: Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>
```

## ModelProviderPlugin

One model provider plugin.

```ts
interface ModelProviderPlugin {
  /** Stable, persisted identifier: the llm-zoo provider or API-key id. */
  readonly id: string;
  /** The provider's own name. */
  readonly displayName: string;
  /** Users can configure a direct API key for this provider. */
  readonly apiKey?: true;
  /** Environment variable for the key when it is not `<ID>_API_KEY`. */
  readonly apiKeyEnvName?: string;
  /**
   * Default HTTP base URL, or a China/international pair chosen by the
   * region toggle. `null`: an llm-zoo provider with no HTTP route of its
   * own (checked below, so a dropped endpoint is a compile error). Absent:
   * a plugin outside llm-zoo's `ModelProvider` (`kimiCode`).
   */
  readonly baseUrl?: string | RegionalBaseUrl | null;
}
```

## modelRefOf

The model reference a stored model string names, without its effort or
mode: what availability, enablement and per-model settings are keyed by.

```ts
function modelRefOf(id: string): string | undefined
```

## ModelRoute

The route a model's next request takes, decided by {@link decideModelRoute}.

```ts
type ModelRoute =
  | { readonly kind: 'validation' }
  | {
      readonly kind: 'chatgpt-subscription';
      /** The input window the Codex backend grants this model. */
      readonly contextWindow: number;
    }
  | { readonly kind: 'xai-subscription' }
  | {
      readonly kind: 'api-key';
      readonly provider: ApiKeyProviderId;
      readonly usageRoute: ApiKeyUsageRoute;
    }
  /** No provider key can serve the model directly. */
  | { readonly kind: 'no-api-key' }
  /** No route TeXRA reaches serves the model (see {@link isUnservedModel}). */
  | { readonly kind: 'unserved' };
```

## originOf

The origin a wire model stamps on its turns: the one place `codecVersion` is written.

```ts
const originOf: <P extends ModelOrigin["protocol"]>(config: Pick<{ readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: 1; }, "deployment" | "requestedModel"> & { readonly protocol: P; }) => { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: 1; } & { readonly protocol: P; }
```

## OWN_KEY_ROUTE_FACTS

The facts under which a model takes its own key: no preference is on.

```ts
const OWN_KEY_ROUTE_FACTS: RouteDecisionFacts
```

## PlanRoute

A subscription plan, named by the route that bills through it.

```ts
type PlanRoute = typeof PlanRouteSchema.Type;
```

## PreparedHistoryEntry

What the prepared-history rules read of an entry: its role, an
assistant's local calls and a tool group's ordinals. Over any input-part
shape, so a store that holds media by address checks the same rules.

```ts
type PreparedHistoryEntry =
  | { readonly role: 'user' | 'system' }
  | {
      readonly role: 'assistant';
      readonly content: readonly { readonly kind: string }[];
    }
  | {
      readonly role: 'tool';
      readonly results: readonly { readonly callOrdinal: number }[];
    };
```

## PreparedHistorySchema

The history a turn sends, under the prepared-history rules.

```ts
const PreparedHistorySchema: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>
```

## providerDisplayName

A provider's own name, the one people know it by, falling back to the id
when the id names no provider plugin.

```ts
function providerDisplayName(provider: string): string
```

## ReasoningChoice

What a request asks for, and how that differs from what was selected.

```ts
interface ReasoningChoice {
  /** Whether the model thinks on this request. */
  readonly thinking: boolean;
  /** The effort level to send; `null` sends none (the model has no effort control, or thinking is off without one). */
  readonly effort: ReasoningEffort | null;
  readonly mode: ReasoningMode | null;
  /** The level that was asked for (explicitly or by default), when it differs from `effort`. */
  readonly requested?: ReasoningEffort;
  /** Why `effort` differs from `requested`, for the run's log. */
  readonly note?: string;
}
```

## ReasoningChoiceError

A selection the model cannot run as asked.

```ts
class ReasoningChoiceError extends Schema.TaggedError<ReasoningChoiceError>()(
  'ReasoningChoiceError',
  { message: Schema.String },
)
```

## ReasoningRequest

The part of a selection that says how to run the model.

```ts
type ReasoningRequest = Omit<ModelSelection, 'ref'>;
```

## RegionalBaseUrl

A default endpoint that depends on the provider's region toggle.

```ts
interface RegionalBaseUrl {
  readonly china: string;
  readonly international: string;
}
```

## RegionalProviderId

Providers with a China and an international platform.

```ts
type RegionalProviderId = Extract<
  (typeof MANIFEST)[number],
  { readonly baseUrl: RegionalBaseUrl }
>['id'];
```

## RemoteOperation

{@link RemoteOperationSchema}'s value.

```ts
type RemoteOperation = typeof RemoteOperationSchema.Type;
```

## RemoteOperationSchema

Remote work a provider accepted: enough to observe or cancel it later.

```ts
const RemoteOperationSchema: Union<readonly [Struct<{ readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"openai-responses">; }>; readonly providerResponseId: NonEmptyString; readonly afterSequence: NullOr<Int>; }>, Struct<{ readonly providerResponseId: NonEmptyString; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"google-interactions">; }>; readonly afterSequence: Null; }>]>
```

## resolveCredential

The one credential ladder: the persisted secret under `name`, else the
first of `envNames` set in the environment, in order. Both are trimmed and
a blank value reads as unset, so an empty variable does not mask anything.
The environment comes from the ambient Effect `ConfigProvider`, the live
process environment in production; tests replace it through a provider
record rather than mutating `process.env`. API keys and the GitHub token
both read through here, so the value and the origin a status surface
reports can never disagree.

```ts
function resolveCredential(
  store: Pick<CredentialStore, 'get'>,
  name: string,
  envNames: readonly string[],
): Effect.Effect<
  { readonly value: string | undefined; readonly origin: CredentialOrigin },
  SecretsFailed
>
```

## ResolvedTurn

A prepared turn: the request with the binding's controls fixed.

```ts
type ResolvedTurn = typeof ResolvedTurnSchema.Type;
```

## ResolvedTurnSchema

Prepared semantic input; execution never reapplies current defaults.

```ts
const ResolvedTurnSchema: Union<readonly [Union<readonly [Struct<{ readonly tools: $Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"google-interactions">; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly store: Boolean; readonly thinkingLevel: Literals<readonly ["minimal", "low", "medium", "high"]>; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: NonEmptyString; }>]>; }>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: NonEmptyString; readonly coveredSteps: Int; }>; }>>; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"openai-responses">; readonly controls: Struct<{ readonly maxOutputTokens: NullOr<Int>; readonly temperature: NullOr<Number>; readonly store: Boolean; readonly parallelToolCalls: Boolean; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: NonEmptyString; }>]>; readonly reasoning: NullOr<Struct<{ readonly effort: NullOr<Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>; readonly mode: NullOr<Literals<readonly ["standard", "pro"]>>; readonly summary: NullOr<Literals<readonly ["auto", "concise", "detailed"]>>; }>>; readonly serviceTier: NullOr<Literal<"fast">>; readonly promptCacheKey: optional<NonEmptyString>; }>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: NonEmptyString; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>>; readonly transport: Union<readonly [Struct<{ readonly kind: Literal<"http">; }>, Struct<{ readonly kind: Literal<"websocket">; readonly connectionId: String; }>]>; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"anthropic-messages">; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly parallelToolCalls: Boolean; readonly toolChoice: Literal<"auto">; readonly thinking: Union<readonly [Struct<{ readonly mode: Literal<"disabled">; }>, Struct<{ readonly mode: Literal<"adaptive">; readonly display: Literal<"summarized">; }>, Struct<{ readonly mode: Literal<"enabled">; readonly budgetTokens: Int; readonly display: Literal<"summarized">; }>]>; readonly effort: NullOr<Literals<readonly ["low", "medium", "high", "xhigh", "max"]>>; readonly cache: Literals<readonly ["disabled", "5m"]>; readonly stopSequences: $Array<String>; }>; }>]>, Union<readonly [Struct<{ readonly tools: $Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literal<"openai-responses">; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: NonEmptyString; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly controls: Struct<{ readonly maxOutputTokens: NullOr<Int>; readonly temperature: NullOr<Number>; readonly store: Boolean; readonly parallelToolCalls: Boolean; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: NonEmptyString; }>]>; readonly reasoning: NullOr<Struct<{ readonly effort: NullOr<Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>; readonly mode: NullOr<Literals<readonly ["standard", "pro"]>>; readonly summary: NullOr<Literals<readonly ["auto", "concise", "detailed"]>>; }>>; readonly serviceTier: NullOr<Literal<"fast">>; readonly promptCacheKey: optional<NonEmptyString>; }>; readonly mode: Literal<"background">; readonly transport: Struct<{ readonly kind: Literal<"http">; }>; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literal<"google-interactions">; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: NonEmptyString; readonly coveredSteps: Int; }>; }>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly store: Boolean; readonly thinkingLevel: Literals<readonly ["minimal", "low", "medium", "high"]>; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: NonEmptyString; }>]>; }>; readonly mode: Literal<"background">; }>]>]>
```

## resolveModelSource

Product-facing model source; direct managed services own their own group.

```ts
function resolveModelSource(
  config: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string
```

## resolveRouteEndpoint

The endpoint `route` sends `config`'s requests to, or `undefined` when no
endpoint is stated for the provider (a regional provider the host gave no
endpoint).

```ts
function resolveRouteEndpoint(
  config: Pick<ModelConfig, 'provider' | 'baseUrl'>,
  route: Extract<
    ModelRoute,
    { kind: 'api-key' | 'chatgpt-subscription' | 'xai-subscription' }
  >,
  facts: Pick<RouteFacts, 'endpoints'>,
): string | undefined
```

## routeConfig

The config `config` runs with on `route`: a subscription's zero per-token
price and context ceiling, and for a dual-backend Kimi model on Kimi Code
the coding wire id and tier window. The endpoint is not part of it: the
route itself names the credential and endpoint (`./routeEndpoint.ts`).

```ts
function routeConfig(
  config: ModelConfig,
  route: ModelRoute,
  facts: Pick<RouteFacts, 'chatgptContextWindow'>,
): ModelConfig
```

## RouteDecisionFacts

The facts {@link decideModelRoute} reads.

```ts
type RouteDecisionFacts = Omit<
  RouteFacts,
  'chatgptContextWindow' | 'endpoints'
>;
```

## RouteFacts

The facts a route reads, and nothing else.

```ts
interface RouteFacts {
  /** A guarded package-validation run: every model binds the validation model. */
  readonly validation: boolean;
  /** The provider reasoning mode the request asks for (OpenAI `pro`), if any. */
  readonly mode?: ReasoningMode;
  /** ChatGPT subscription preferred, signed in, and not declined. */
  readonly chatgptSubscription: boolean;
  /** Grok subscription preferred, signed in, and not declined. */
  readonly xaiSubscription: boolean;
  /** A Kimi Code console key is stored. */
  readonly kimiCodeKey: boolean;
  /** The "Kimi Code subscription" switch is on and not declined. */
  readonly preferKimiCode: boolean;
  /** The GLM Coding Plan is on, not declined, and no dashboard GLM endpoint
   *  outranks its path. */
  readonly glmCodingPlan: boolean;
  /**
   * The user's input window override, in tokens, for the ChatGPT
   * subscription; `undefined` takes the window the backend grants the model.
   */
  readonly chatgptContextWindow: number | undefined;
  /**
   * The host's endpoint per provider id: a dashboard URL, or the default of
   * the region the provider's toggle picks. A provider absent here takes its
   * catalog default (`resolveRouteEndpoint`).
   */
  readonly endpoints: Readonly<Partial<Record<string, string>>>;
}
```

## sameModelOrigin

Compares the complete non-secret binding, not runtime lineage. A `null`
left side (content no model produced) matches no binding.

```ts
function sameModelOrigin(
  left: ModelOrigin | null,
  right: ModelOrigin,
): boolean
```

## SecretsFailed

The one failure of a credential store. Callers match on `reason` rather
than on a message: a surface that wants to distinguish "nothing can be
stored here" from "the store is broken" reads the tag, and a caller that
wants neither still sees a typed error instead of `unknown`.

```ts
class SecretsFailed extends Schema.TaggedError<SecretsFailed>()(
  'SecretsFailed',
  {
    /**
     * Why it failed, as the host stores can actually fail:
     * `store-unavailable` — the host has no store to write to at all (an
     * embedder that persists nothing; only {@link CredentialStore.set} raises
     * it); `io` — the backing file or host API failed.
     */
    reason: Schema.Literals(['store-unavailable', 'io']),
    operation: SecretsOperationSchema,
    message: Schema.String,
    key: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
)
```

## SecretsOperation

{@link SecretsOperationSchema}'s value.

```ts
type SecretsOperation = typeof SecretsOperationSchema.Type;
```

## SelectedModel

A stored model string resolved against the catalog.

```ts
interface SelectedModel {
  readonly config: ModelConfig;
  /** The effort, thinking and mode the string asks for, if any. */
  readonly request: Omit<ModelSelection, 'ref'>;
}
```

## selectModel

The model and reasoning request a stored model string names, or `undefined` when it names no registered model.

```ts
function selectModel(id: string): SelectedModel | undefined
```

## systemUpdateText

A mid-conversation system message as the user text any protocol takes.

```ts
const systemUpdateText: (text: string) => string
```

## turnCost

The cost of one turn, never negative. A plan route (ChatGPT/Codex, Grok,
the GLM coding plan, Kimi Code) is covered by the subscription, so every
rate is zero and a receipt the provider settled bills an API key this turn
did not use. An API-key route bills the catalog's rates on its service
tier; a model with a long-context tier bills the whole request at it once
the prompt, cached tokens included, is above it (llm-zoo's
`requestRates`). An xAI receipt carries its own settled cost, which wins
over the computed one.

```ts
function turnCost(
  model: ModelConfig,
  usage: TurnUsage,
  billing: { readonly plan: boolean; readonly tier?: 'fast' },
): number
```

## TurnEvent

A streamed turn's event: its identity, a text delta, or the result.

```ts
type TurnEvent = typeof TurnEventSchema.Type;
```

## TurnProtocolSchema

Every wire surface the package speaks. Usage is billed per surface, so a
usage record's provider is the protocol of the turn that produced it.

```ts
const TurnProtocolSchema: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>
```

## TurnRequest

A turn as the caller asks for it, before the binding's defaults apply.

```ts
type TurnRequest = typeof TurnRequestSchema.Type;
```

## TurnRequestSchema

Materialized input; no SDK value, credential, file path or storage reference.

```ts
const TurnRequestSchema: Struct<{ readonly mode: optional<Literals<readonly ["foreground", "background"]>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: NonEmptyString; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: NonEmptyString; }>]>>; readonly tools: optional<$Array<Struct<{ readonly name: NonEmptyString; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>>; readonly toolChoice: optional<Union<readonly [Literal<"auto">, Struct<{ readonly name: NonEmptyString; }>]>>; readonly maxOutputTokens: optional<Int>; readonly store: optional<Boolean>; readonly continuation: optional<Union<readonly [Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: NonEmptyString; readonly coveredSteps: Int; }>; }>, Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: NonEmptyString; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>]>>; readonly cacheKey: optional<NonEmptyString>; }>
```

## TurnResult

A completed provider turn: its content, finish reason and usage.

```ts
type TurnResult = typeof TurnResultSchema.Type;
```

## TurnResultSchema

A completed provider turn, not a completed agent execution.

```ts
const TurnResultSchema: Struct<{ readonly providerResponseId: NullOr<NonEmptyString>; readonly modelFingerprint: NullOr<String>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: NonEmptyString; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: NonEmptyString; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: NonEmptyString; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: NonEmptyString; readonly name: NonEmptyString; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<NonEmptyString>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; readonly finishReason: Literals<readonly ["stop", "length", "content-filter", "tool-calls", "stop-sequence", "refusal", "context-window-exceeded"]>; readonly stopSequence: optional<String>; readonly finishEvidence: optional<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions">; readonly status: NonEmptyString; readonly terminalReason: NullOr<NonEmptyString>; }>, Struct<{ readonly kind: Literal<"openai-responses">; readonly status: Literals<readonly ["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"]>; readonly incompleteReason: NullOr<Literals<readonly ["max_output_tokens", "content_filter"]>>; }>]>>; readonly refusalEvidence: optional<NullOr<Struct<{ readonly kind: Literal<"anthropic-refusal">; readonly category: NullOr<Literals<readonly ["cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms"]>>; readonly explanation: NullOr<String>; }>>>; readonly usage: NullOr<Struct<{ readonly inputTokens: NullOr<Int>; readonly outputTokens: NullOr<Int>; readonly totalTokens: NullOr<Int>; readonly cachedInputTokens: NullOr<Int>; readonly reasoningTokens: NullOr<Int>; readonly providerUsage: optional<Union<readonly [Struct<{ readonly kind: Literal<"google">; readonly toolUsePromptTokens: NullOr<Int>; }>, Struct<{ readonly kind: Literal<"xai">; readonly costInUsdTicks: NullOr<Int>; }>, Struct<{ readonly kind: Literal<"anthropic">; readonly uncachedInputTokens: NullOr<Int>; readonly cacheCreationTokens: NullOr<Int>; readonly cacheCreation5mTokens: NullOr<Int>; readonly cacheCreation1hTokens: NullOr<Int>; }>]>>; }>>; readonly continuation: optional<Union<readonly [Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: NonEmptyString; readonly coveredSteps: Int; }>; }>, Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly requestedModel: NonEmptyString; readonly codecVersion: Literal<1>; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: NonEmptyString; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>]>>; readonly requestedOrigin: Struct<{ readonly requestedModel: NonEmptyString; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: NonEmptyString; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Literal<1>; }>; readonly returnedModel: NullOr<NonEmptyString>; readonly kind: Literal<"http">; }>
```

## TurnUsage

{@link TurnUsageSchema}'s value.

```ts
type TurnUsage = typeof TurnUsageSchema.Type;
```

## UnreleasedUpload

A file a binding uploaded and could not confirm it deleted.

```ts
interface UnreleasedUpload {
  readonly fileId: string;
  readonly reason: string;
}
```

## wireEffort

The effort a route sends: the chosen level, or `none` when thinking is off and `none` is how the route says so.

```ts
function wireEffort(
  config: ModelConfig,
  reasoning: ReasoningChoice,
): ReasoningEffort | null
```

## zeroCostAccessOverrides

The config fields of a route billed by subscription, not per token, over
the context window the caller resolved for that route. A covered route
bills no tier either: a long-prompt or fast-tier rate left on the config
would price a request the subscription paid for.

```ts
function zeroCostAccessOverrides(contextWindow: number): {
  readonly inputPrice: 0;
  readonly outputPrice: 0;
  readonly contextWindow: number;
  readonly longContextPricing: undefined;
  readonly tiers: undefined;
}
```
