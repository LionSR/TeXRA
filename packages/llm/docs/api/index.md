# `@texra-ai/llm`

<!-- Generated from `packages/llm/src/index.ts` by `npm run docgen`; do not edit. -->

Browser-safe entry of `@texra-ai/llm`: the turn contract, model and provider
catalogs, route decisions, reasoning selection, turn cost, and `ModelError`.

> **Guide:** Read [Model Layer (`@texra-ai/llm`)](/api/model-layer) for how
> catalog selection, route resolution, `prepareTurn` / `streamTurn`, and
> `ModelError` work together.

### Key exports by role

- **Turn contract**: [`Model`](#model) (`prepareTurn`, `streamTurn`),
  [`TurnRequest`](#turnrequest) ([`TurnRequestSchema`](#turnrequestschema)),
  [`ResolvedTurn`](#resolvedturn), [`TurnEvent`](#turnevent),
  [`TurnResult`](#turnresult), and [`completedTurn`](#completedturn).
- **Model & provider catalogs**: [`selectModel`](#selectmodel),
  [`MODEL_PROVIDER_PLUGINS`](#model_provider_plugins),
  [`decideModelRoute`](#decidemodelroute),
  [`RouteFacts`](#routefacts) ([`OWN_KEY_ROUTE_FACTS`](#own_key_route_facts)),
  [`chooseReasoning`](#choosereasoning), and [`turnCost`](#turncost).
- **Structured failures & credentials**: [`ModelError`](#modelerror),
  [`ModelErrorFields`](#modelerrorfields), and
  [`CredentialStore`](#credentialstore).

Binding a model to its wire protocol (`bindModel`) and running subscription
OAuth flows live in [`@texra-ai/llm/node`](./node).

## acceptedEfforts

The effort values `route` may send for a model: the levels it accepts
while thinking, plus `none` where `none` is how thinking is turned off.
Without a route, the model's own.

```ts
function acceptedEfforts(
  config: Pick<ModelConfig, 'provider' | 'reasoning'>,
  route?: Pick<ModelRoute, 'kind'>,
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
for direct key-provider enumeration, derived from the plugin manifest.
Order = display order in the settings key rows.

```ts
const API_KEY_PROVIDER_IDS: readonly ApiKeyProviderId[]
```

## apiKey

The provider's key and where it came from, through the one credential
ladder: the secret store (the authority; no copy of it is cached here),
then the provider's conventional environment variable. A program: a caller
yields it and matches {@link SecretsFailed} instead of catching `unknown`
from a rejected read.

```ts
function apiKey(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<ResolvedApiKey, SecretsFailed>
```

## apiKeyEntry

What a secret-store entry is, the inverse of {@link apiKeySecretName}: the
provider whose API key it holds, `'unknown'` for an API-key entry of no
provider this build knows, or `undefined` for every other entry (OAuth
tokens, the GitHub token).

```ts
function apiKeyEntry(
  key: string,
): ApiKeyProviderId | 'unknown' | undefined
```

## apiKeyEnvName

Environment variable for a provider's API key.

```ts
function apiKeyEnvName(provider: ApiKeyProviderId): string
```

## apiKeyOrigins

Where every API-key provider's key comes from.

```ts
function apiKeyOrigins(
  credentials: CredentialStore,
): Effect.Effect<Record<ApiKeyProviderId, CredentialOrigin>, SecretsFailed>
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

## ApiKeyUsageRoute

What a direct provider key pays through: a `key` plan, or nothing.

```ts
type ApiKeyUsageRoute =
  | 'api-key'
  | {
      [P in PlanRoute]: (typeof PLAN_ROUTES)[P]['credential'] extends 'key'
        ? P
        : never;
    }[PlanRoute];
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
const AssistantMessageSchema: Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>
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
next message, in call order. Only the next request needs them answered.
Returns the schema issues found, one per offending message.

```ts
function checkPreparedHistory(
  messages: readonly PreparedHistoryEntry[],
): Schema.FilterIssue[]
```

## chooseReasoning

Decide thinking, effort and mode for one request, over the controls the
model has on `options.route`.

- The effort is the selection's, else the user's saved level, else
  {@link DEFAULT_EFFORT}.
- `none` turns thinking off; it is refused on a model that cannot stop
  thinking, as is thinking on a model that never thinks, because on/off
  changes the kind of answer, not its amount.
- Any other level the model lacks becomes the nearest level it has (ties
  go up), reported in `note`.

```ts
function chooseReasoning(
  config: Pick<ModelConfig, 'label' | 'provider' | 'reasoning' | 'modes'>,
  request: ReasoningRequest = {},
  options: ChooseReasoningOptions = {},
): ReasoningChoice
```

## ChooseReasoningOptions

How {@link chooseReasoning} resolves a request the model cannot serve.

```ts
interface ChooseReasoningOptions {
  /** The user's saved level for this model, used when the selection names none. */
  readonly userEffort?: ReasoningEffort;
  /** The route the request is bound on, which may carry fewer controls than the model has. */
  readonly route?: Pick<ModelRoute, 'kind'>;
  /** The caller's own ceiling on the levels it can serve (e.g. an installed Codex CLI's). */
  readonly routeEfforts?: readonly ReasoningEffort[];
}
```

## codexBackendModelId

The model id the Codex backend keys on: the API `id` with its llm-zoo date
pin stripped.

Never the `shortName`: that is llm-zoo's display abbreviation, and for
GPT-5.6 Sol it is a bare `gpt-5.6`, which is not a model. The backend
answers it with "The 'gpt-5.6' model is not supported when using Codex with
a ChatGPT account", which reads as a plan problem rather than a bad id.

```ts
function codexBackendModelId(config: Pick<ModelConfig, 'id'>): string
```

## completedTurn

A foreground turn's completed result: assembled from `streamTurn`'s events.

```ts
const completedTurn: (events: Stream<{ readonly kind: "completed"; readonly result: { readonly kind: "http"; readonly usage: { readonly cachedInputTokens: number | null; readonly cacheWriteTokens: number | null; readonly reasoningTokens: number | null; readonly toolUsePromptTokens: number | null; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null; readonly providerUsage?: { readonly kind: "xai"; readonly costInUsdTicks: number | null; } | { readonly kind: "anthropic"; readonly uncachedInputTokens: number | null; readonly cacheCreation5mTokens: number | null; readonly cacheCreation1hTokens: number | null; } | undefined; } | null; readonly content: readonly ({ readonly kind: "message"; readonly content: readonly ({ readonly kind: "text"; readonly text: string; } | { readonly kind: "refusal"; readonly text: string; })[]; readonly evidence?: { readonly kind: "openai-responses-message"; readonly status: "completed" | "incomplete"; readonly itemId: string; readonly phase?: "commentary" | "final_answer" | null | undefined; } | undefined; } | { readonly kind: "reasoning"; readonly evidence: { readonly kind: "google-interactions-thought-signature"; readonly signature: string; } | { readonly kind: "openai-responses-reasoning"; readonly itemId: string; readonly status?: "completed" | "incomplete" | undefined; readonly encryptedContent?: string | null | undefined; } | { readonly kind: "anthropic-thinking-signature"; readonly signature: string; } | { readonly kind: "anthropic-redacted-thinking"; readonly data: string; } | null; readonly summary: readonly { readonly kind: "text"; readonly text: string; }[]; readonly content?: readonly { readonly kind: "text"; readonly text: string; }[] | undefined; } | { readonly kind: "local-call"; readonly name: string; readonly providerCallId: string; readonly argumentsText: string; readonly evidence?: { readonly kind: "openai-responses-function-call"; readonly status?: "completed" | undefined; readonly itemId?: string | undefined; } | undefined; })[]; readonly providerResponseId: string | null; readonly returnedModel: string | null; readonly modelFingerprint: string | null; readonly finishReason: "length" | "content-filter" | "stop" | "refusal" | "tool-calls"; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: number; }; readonly finishEvidence?: { readonly kind: "google-interactions"; readonly status: string; readonly terminalReason: string | null; } | { readonly kind: "openai-responses"; readonly status: "in_progress" | "completed" | "failed" | "cancelled" | "queued" | "incomplete"; readonly incompleteReason: "max_output_tokens" | "content_filter" | null; } | undefined; readonly refusalEvidence?: { readonly kind: "anthropic-refusal"; readonly category: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null; readonly explanation: string | null; } | null | undefined; readonly continuation?: { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: number; readonly protocol: "google-interactions"; }; readonly anchor: { readonly interactionId: string; readonly coveredSteps: number; }; } | { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: number; readonly protocol: "openai-responses"; }; readonly anchor: { readonly responseId: string; readonly coveredItems: number; readonly kind: "stored"; }; } | undefined; }; } | { readonly providerResponseId: string; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: number; }; readonly returnedModel: string | null; readonly kind: "identified"; } | { readonly kind: "delta"; readonly part: "text" | "refusal" | "reasoning"; readonly text: string; }, ModelError, never>) => Effect<{ readonly kind: "http"; readonly usage: { readonly cachedInputTokens: number | null; readonly cacheWriteTokens: number | null; readonly reasoningTokens: number | null; readonly toolUsePromptTokens: number | null; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null; readonly providerUsage?: { readonly kind: "xai"; readonly costInUsdTicks: number | null; } | { readonly kind: "anthropic"; readonly uncachedInputTokens: number | null; readonly cacheCreation5mTokens: number | null; readonly cacheCreation1hTokens: number | null; } | undefined; } | null; readonly content: readonly ({ readonly kind: "message"; readonly content: readonly ({ readonly kind: "text"; readonly text: string; } | { readonly kind: "refusal"; readonly text: string; })[]; readonly evidence?: { readonly kind: "openai-responses-message"; readonly status: "completed" | "incomplete"; readonly itemId: string; readonly phase?: "commentary" | "final_answer" | null | undefined; } | undefined; } | { readonly kind: "reasoning"; readonly evidence: { readonly kind: "google-interactions-thought-signature"; readonly signature: string; } | { readonly kind: "openai-responses-reasoning"; readonly itemId: string; readonly status?: "completed" | "incomplete" | undefined; readonly encryptedContent?: string | null | undefined; } | { readonly kind: "anthropic-thinking-signature"; readonly signature: string; } | { readonly kind: "anthropic-redacted-thinking"; readonly data: string; } | null; readonly summary: readonly { readonly kind: "text"; readonly text: string; }[]; readonly content?: readonly { readonly kind: "text"; readonly text: string; }[] | undefined; } | { readonly kind: "local-call"; readonly name: string; readonly providerCallId: string; readonly argumentsText: string; readonly evidence?: { readonly kind: "openai-responses-function-call"; readonly status?: "completed" | undefined; readonly itemId?: string | undefined; } | undefined; })[]; readonly providerResponseId: string | null; readonly returnedModel: string | null; readonly modelFingerprint: string | null; readonly finishReason: "length" | "content-filter" | "stop" | "refusal" | "tool-calls"; readonly requestedOrigin: { readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: number; }; readonly finishEvidence?: { readonly kind: "google-interactions"; readonly status: string; readonly terminalReason: string | null; } | { readonly kind: "openai-responses"; readonly status: "in_progress" | "completed" | "failed" | "cancelled" | "queued" | "incomplete"; readonly incompleteReason: "max_output_tokens" | "content_filter" | null; } | undefined; readonly refusalEvidence?: { readonly kind: "anthropic-refusal"; readonly category: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null; readonly explanation: string | null; } | null | undefined; readonly continuation?: { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: number; readonly protocol: "google-interactions"; }; readonly anchor: { readonly interactionId: string; readonly coveredSteps: number; }; } | { readonly coveredMessages: number; readonly prefixFingerprint: string; readonly origin: { readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly requestedModel: string; readonly codecVersion: number; readonly protocol: "openai-responses"; }; readonly anchor: { readonly responseId: string; readonly coveredItems: number; readonly kind: "stored"; }; } | undefined; }, ModelError, never>
```

## Continuation

{@link ContinuationSchema}'s value.

```ts
type Continuation = typeof ContinuationSchema.Type;
```

## CredentialOrigin

{@link CredentialOriginSchema}'s value.

```ts
type CredentialOrigin = typeof CredentialOriginSchema.Type;
```

## CredentialOriginSchema

Where a resolved credential came from: the host's secret store, the
environment, or nowhere. The one vocabulary every status surface and wire
message about a credential carries.

```ts
const CredentialOriginSchema: Literals<readonly ["secret", "env", "none"]>
```

## CredentialRoute

The routes that bill a credential: a key, or a session plan's sign-in.

```ts
type CredentialRoute = Exclude<
  ModelRoute,
  { kind: 'no-api-key' | 'unserved' }
>;
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
  facts: RouteFacts,
): ModelRoute
```

## DEFAULT_MODEL_CAPABILITIES

Base model capabilities with sensible defaults.
Models should spread this and override specific capabilities.

```ts
const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities
```

## EFFORT_SCALE

The shared effort scale, lowest first. Every model's accepted levels are a
subset of it, so a requested level can be compared with any model's list.
`none` means "do not think".

```ts
const EFFORT_SCALE: readonly ReasoningEffort[]
```

## EndpointProviderId

Providers with an HTTP endpoint of their own, which a host may override.

```ts
type EndpointProviderId = Extract<
  (typeof MANIFEST)[number],
  { readonly baseUrl: string | RegionalBaseUrl }
>['id'];
```

## exposeApiKey

Unwrap a sealed key at the one point it is handed to a foreign runtime: a
provider SDK, a subprocess environment, a usage client. Every other caller
keeps the `Redacted` value, which renders as `<redacted:provider>` in a log,
a trace, or `JSON.stringify`. Named rather than inlined so the places that
expose a credential are greppable, and so a caller need not import `effect`
to hand a key onward.

```ts
function exposeApiKey(key: Redacted.Redacted<string>): string
```

## FileUpload

{@link FileUploadSchema}'s value.

```ts
type FileUpload = typeof FileUploadSchema.Type;
```

## fillModelError

A `ModelError` completed with what an outer scope knows. A field the error
already carries is never overwritten: the scope nearest the failure, such
as the turn assembly that learned the returned model, recorded it first.
`message` and `cause` live on `Error` as own non-enumerable properties, so
the spread that carries every other field would drop both; restating them
keeps a re-thrown error's text and origin.

```ts
const fillModelError: (error: ModelError, known: Partial<ModelErrorFields>) => ModelError
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

## hint

Generate a dynamic hint string for a model, suitable for dropdown tooltips.
Combines context window size and pricing info.

- `@example` ```typescript
  hint('anthropic/claude-sonnet-4-5');
  // → "200K context, $3/$15 per 1M tokens"
  
  hint('openai/gpt-4o-2024-11-20');
  // → "128K context, $2.50/$10 per 1M tokens"
  
  // Also accepts a ModelConfig directly
  const model = lookup('anthropic/claude-opus-4-6');
  hint(model);
  // → "200K context, $15/$75 per 1M tokens"
  ```

```ts
declare function hint(model: ModelConfig | string): string;
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

## MessageSchema

One message of the history a turn sends (user, assistant, tool, system).

```ts
const MessageSchema: Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>
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
```

## MODEL_CONFIGS

Complete registry of all available model configurations, keyed by
`${provider}/${id}`.

- `@example` ```typescript
  import { MODEL_CONFIGS } from 'llm-zoo';
  
  const opus = MODEL_CONFIGS['anthropic/claude-opus-5'];
  console.log(opus.contextWindow);      // 1000000
  console.log(opus.reasoning?.efforts); // ['low', 'medium', 'high', 'xhigh', 'max']
  ```

```ts
const MODEL_CONFIGS: Readonly<Record<ModelRef, ModelConfig>>
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

## ModelConfig

Complete configuration for a language model.
Contains all metadata needed to work with the model including
pricing, capabilities, and provider-specific settings.

```ts
interface ModelConfig {
    /** Registry key: `${provider}/${id}`. */
    ref: ModelRef;
    /**
     * The model ID the provider's API takes (e.g. "claude-opus-5", "gpt-4o-2024-11-20").
     * This is the string sent to the provider.
     */
    id: string;
    /**
     * Unpinned API model name without date suffix (e.g., "gpt-5.4", "claude-opus-4-1").
     * Equals `id` when the model has no date-pinned variant.
     * Useful for providers/clients that prefer non-date-pinned model identifiers.
     */
    shortName: string;
    /** The model's provider */
    provider: ModelProvider;
    /** Maximum tokens the model can generate in a single response */
    maxOutputTokens: number;
    /** Cost per million input tokens in USD */
    inputPrice: number;
    /** Cost per million output tokens in USD */
    outputPrice: number;
    /** Maximum context window size in tokens */
    contextWindow: number;
    /** Model capability flags */
    capabilities: ModelCapabilities;
    /** How the model reasons; absent when it never thinks. */
    reasoning?: ReasoningSpec;
    /** Request modes the model accepts beyond the default. OpenAI's `pro` exists only in the Responses API. */
    modes?: readonly ReasoningMode[];
    /**
     * Service tiers beyond standard, with their prices (e.g. OpenAI
     * `service_tier: 'fast'`). Choosing a tier is a routing decision of the
     * caller, never part of a model selection. A tier can carry its own
     * long-context rates; read them through `requestRates` with that tier.
     */
    tiers?: {
        fast?: TokenPrices & {
            longContextPricing?: LongContextPricing;
        };
    };
    /**
     * Long-prompt pricing tier, when the provider documents one. Absent means
     * the flat rates apply at every prompt size. Read through `requestRates`.
     */
    longContextPricing?: LongContextPricing;
    /** Where these facts were checked. Required for every model that is not retired. */
    source?: ModelSource;
    /**
     * Whether this model is only available through OpenRouter.
     * When true, direct API access is not available.
     */
    openRouterOnly: boolean;
    /**
     * Model identifier for OpenRouter API.
     * Example: "anthropic/claude-sonnet-4.5"
     */
    openrouterFullName?: string;
    /**
     * Model identifier for the VS Code Language Model API (`vscode.lm`).
     * Example: "claude-sonnet-4.5" (matches the `id` field of a vscode.lm ChatModel).
     */
    vscodeLMFullName?: string;
    /** Exact model identifier documented for GitHub Copilot model selection. */
    copilotFullName?: string;
    /**
     * Custom base URL for this specific model.
     * Overrides the provider's default endpoint.
     */
    baseUrl?: string;
    /**
     * Whether this model requires OpenAI's Responses API format.
     * Used for special models like deep research that bypass standard chat completions.
     */
    requiresResponsesAPI?: boolean;
    /**
     * Human-friendly display name for the model.
     * Used as the label in model dropdowns so users can identify models at a glance.
     */
    label: string;
    /**
     * Present when the Codex backend (ChatGPT subscription) currently serves
     * this model, with the input context window that backend grants it, which
     * is smaller than the API's. Source of truth: the backend's model catalog
     * (`chatgpt.com/backend-api/codex/models`, the `context_window` the Codex
     * CLI caches in `~/.codex/models_cache.json`; it needs a ChatGPT sign-in)
     * cross-checked against the manifest embedded in the Codex CLI
     * (`codex-rs/models-manager/models.json`) and
     * https://developers.openai.com/codex/models —
     * serving status is not derivable from the model name, reasoning tier, or
     * deprecation status.
     */
    codexSubscription?: {
        contextWindow: number;
    };
    /**
     * Whether the Kimi Code backend (Moonshot coding-subscription plan) serves
     * this model. Kimi Code models are exclusive to the managed endpoint
     * `https://api.kimi.com/coding/v1` (OAuth device-flow token or console API
     * key) — they are NOT served by the Moonshot open platform, and open-platform
     * keys do not work on the coding endpoint. Source of truth: kimi-cli's
     * platform registry and https://www.kimi.com/code/docs/en/.
     * @default false
     */
    kimiSubscription?: boolean;
    /**
     * Whether this model is deprecated and no longer recommended for use.
     * Deprecated models are still functional but have been superseded by newer versions.
     * @default false
     */
    deprecated?: boolean;
    /**
     * Whether this model has been retired and is no longer served by the provider.
     * Retired models cannot be used for inference — API calls will fail.
     * @default false
     */
    retired?: boolean;
}
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
const ModelOriginSchema: Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>
```

## ModelProvider

Supported language model providers.
Each provider has specific API formats, capabilities, and pricing structures.

```ts
declare enum ModelProvider {
    /** Anthropic (Claude models) */
    ANTHROPIC = "anthropic",
    /** OpenAI (GPT, o-series models) */
    OPENAI = "openai",
    /** Google (Gemini models) */
    GOOGLE = "google",
    /** DeepSeek (V3, R1 models) */
    DEEPSEEK = "deepseek",
    /** xAI (Grok models) */
    XAI = "xai",
    /** Moonshot AI (Kimi models) */
    MOONSHOT = "moonshot",
    /** Alibaba DashScope (Qwen models) */
    DASHSCOPE = "dashscope",
    /** MiniMax (M-series models) */
    MINIMAX = "minimax",
    /** GitHub Copilot */
    COPILOT = "copilot",
    /** Zhipu AI (GLM models) */
    GLM = "glm",
    /** Meta (Muse Spark models via Meta Model API) */
    META = "meta",
    /** Other providers (OpenRouter-only models, etc.) */
    OTHERS = "others"
}
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

## ModelRef

A model's identity: its provider and the model ID that provider's API takes,
e.g. `anthropic/claude-opus-5`. This is the registry key.

```ts
type ModelRef = `${ModelProvider}/${string}`;
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
  | {
      readonly kind: 'chatgpt-subscription';
      readonly endpoint: string;
      /** The input window: the user's override, else what the Codex backend grants. */
      readonly contextWindow: number;
    }
  | { readonly kind: 'xai-subscription'; readonly endpoint: string }
  | {
      readonly kind: 'api-key';
      readonly endpoint: string;
      readonly provider: ApiKeyProviderId;
      readonly usageRoute: ApiKeyUsageRoute;
    }
  /** No provider key can serve the model directly. */
  | { readonly kind: 'no-api-key' }
  /** No route TeXRA reaches serves the model (see {@link isUnservedModel}). */
  | { readonly kind: 'unserved' };
```

## MODELS

All model references.

```ts
const MODELS: ModelRef[]
```

## originOf

The origin a wire model stamps on its turns: the one place `codecVersion` is written.

```ts
const originOf: <P extends ModelOrigin["protocol"]>(config: Pick<{ readonly requestedModel: string; readonly deployment: { readonly endpoint: string; readonly credentialScope: string; }; readonly protocol: "google-interactions" | "openai-responses" | "anthropic-messages"; readonly codecVersion: number; }, "deployment" | "requestedModel"> & { readonly protocol: P; }) => Readonly<{ protocol: P; requestedModel: string; deployment: { readonly endpoint: string; readonly credentialScope: string; }; codecVersion: 1; }>
```

## OWN_KEY_ROUTE_FACTS

The facts under which a model takes its own key at its default endpoint:
no plan is on and the host names no endpoint.

```ts
const OWN_KEY_ROUTE_FACTS: RouteFacts
```

## PLAN_ROUTES

The subscription plans a model can bill through instead of the caller's
API credit, keyed by the route that bills through each. `provider` is the
account the plan bills. A `session` plan signs in with an OAuth session,
is its own route kind, and renews its token once on a 401; a used-up quota
asks before moving onto an API key, because the move starts spending API
credit. A `key` plan pays for an `api-key` route on a provider console
key, as that route's `usageRoute`; a used-up quota falls back to the
model's own key without asking. Hosts store these spellings, so a key is
never renamed.

```ts
const PLAN_ROUTES: Readonly<{ 'chatgpt-subscription': Readonly<{ provider: "openai"; credential: "session"; }>; 'xai-subscription': Readonly<{ provider: "xai"; credential: "session"; }>; 'kimi-code-subscription': Readonly<{ provider: "kimiCode"; credential: "key"; }>; 'glm-coding-plan-subscription': Readonly<{ provider: "glm"; credential: "key"; }>; }>
```

## PlanRoute

A subscription plan, named by the route that bills through it.

```ts
type PlanRoute = keyof typeof PLAN_ROUTES;
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

## ReasoningEffort

Reasoning effort levels for models that support configurable reasoning depth.
Higher effort typically results in better reasoning quality but increased latency and cost.

```ts
declare enum ReasoningEffort {
    /** Maximum reasoning effort - highest tier, above extra high */
    MAX = "max",
    /** Extra high reasoning effort - maximum depth analysis */
    XHIGH = "xhigh",
    /** High reasoning effort - thorough analysis */
    HIGH = "high",
    /** Medium reasoning effort - balanced analysis */
    MEDIUM = "medium",
    /** Low reasoning effort - quick analysis */
    LOW = "low",
    /** Minimal reasoning effort - near-direct response */
    MINIMAL = "minimal",
    /** No explicit reasoning - standard model behavior */
    NONE = "none"
}
```

## ReasoningEffortSchema

Effect Schema validation schemas for llm-zoo types.
Requires effect ^4.0.0 as peer dependency.

- `@example` ```typescript
  import { Result, Schema } from 'effect';
  import { ModelConfigSchema } from 'llm-zoo/schemas';
  
  const result = Schema.decodeUnknownResult(ModelConfigSchema)(myConfig);
  if (Result.isFailure(result)) {
    console.error(result.failure.message);
  }
  ```

```ts
const ReasoningEffortSchema: Schema.Enum<typeof ReasoningEffort>
```

## ReasoningMode

Request modes beyond the provider default. OpenAI's Responses API accepts `reasoning.mode: 'pro'`.

```ts
type ReasoningMode = 'pro';
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
const RemoteOperationSchema: Struct<{ readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literals<readonly ["openai-responses", "google-interactions"]>; }>; readonly providerResponseId: String; }>
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
const resolveCredential: (store: Pick<CredentialStore, "get">, name: string, envNames: readonly string[]) => Effect<{ readonly value: string | undefined; readonly origin: "none" | "env" | "secret"; }, SecretsFailed, never>
```

## ResolvedApiKey

A provider's key, sealed, and its origin.

```ts
interface ResolvedApiKey {
  /**
   * Held as `Redacted` from the store outward, so every caller carries a value
   * that renders as `<redacted:provider>` if it ever reaches a log, a trace,
   * or `JSON.stringify`. Only the call that hands the credential to a
   * provider client unwraps it.
   */
  value: Redacted.Redacted<string> | undefined;
  origin: CredentialOrigin;
}
```

## ResolvedTurn

A prepared turn: the request with the binding's controls fixed.

```ts
type ResolvedTurn = typeof ResolvedTurnSchema.Type;
```

## ResolvedTurnSchema

Prepared semantic input; execution never reapplies current defaults.

```ts
const ResolvedTurnSchema: Union<readonly [Union<readonly [Struct<{ readonly tools: $Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"google-interactions">; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly store: Boolean; readonly thinkingLevel: Literals<readonly ["minimal", "low", "medium", "high"]>; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: String; }>]>; }>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: String; readonly coveredSteps: Int; }>; }>>; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"openai-responses">; readonly controls: Struct<{ readonly maxOutputTokens: NullOr<Int>; readonly temperature: NullOr<Number>; readonly store: Boolean; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: String; }>]>; readonly reasoning: NullOr<Struct<{ readonly effort: NullOr<Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>; readonly mode: NullOr<Literals<readonly ["standard", "pro"]>>; readonly summary: NullOr<Literal<"auto">>; }>>; readonly serviceTier: NullOr<Literal<"fast">>; readonly promptCacheKey: optional<String>; }>; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: String; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>>; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly mode: Literal<"foreground">; readonly protocol: Literal<"anthropic-messages">; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly toolChoice: Literal<"auto">; readonly thinking: Union<readonly [Struct<{ readonly mode: Literal<"disabled">; }>, Struct<{ readonly mode: Literal<"adaptive">; readonly display: Literal<"summarized">; }>, Struct<{ readonly mode: Literal<"enabled">; readonly budgetTokens: Int; readonly display: Literal<"summarized">; }>]>; readonly effort: NullOr<Literals<readonly ["low", "medium", "high", "xhigh", "max"]>>; readonly cache: Literals<readonly ["disabled", "5m"]>; }>; }>]>, Union<readonly [Struct<{ readonly tools: $Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literal<"openai-responses">; readonly requestedModel: String; readonly codecVersion: Int; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: String; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly controls: Struct<{ readonly maxOutputTokens: NullOr<Int>; readonly temperature: NullOr<Number>; readonly store: Boolean; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: String; }>]>; readonly reasoning: NullOr<Struct<{ readonly effort: NullOr<Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>; readonly mode: NullOr<Literals<readonly ["standard", "pro"]>>; readonly summary: NullOr<Literal<"auto">>; }>>; readonly serviceTier: NullOr<Literal<"fast">>; readonly promptCacheKey: optional<String>; }>; readonly mode: Literal<"background">; }>, Struct<{ readonly tools: $Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literal<"google-interactions">; readonly requestedModel: String; readonly codecVersion: Int; readonly continuation: optional<Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: String; readonly coveredSteps: Int; }>; }>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly controls: Struct<{ readonly maxOutputTokens: Int; readonly store: Boolean; readonly thinkingLevel: Literals<readonly ["minimal", "low", "medium", "high"]>; readonly toolChoice: Union<readonly [Literal<"auto">, Struct<{ readonly name: String; }>]>; }>; readonly mode: Literal<"background">; }>]>]>
```

## resolveModelSource

Product-facing model source; direct managed services own their own group.

```ts
function resolveModelSource(
  config: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string
```

## routeConfig

The config `config` runs with on `route`: a subscription's zero per-token
price and context ceiling, and for a dual-backend Kimi model on Kimi Code
the coding wire id and tier window. The endpoint is not part of it: the
route itself names it.

```ts
function routeConfig(
  config: ModelConfig,
  route: ModelRoute,
): ModelConfig
```

## RouteFacts

The facts a route reads, and nothing else.

```ts
interface RouteFacts {
  /** The provider reasoning mode the request asks for (OpenAI `pro`), if any. */
  readonly mode?: ReasoningMode;
  /**
   * The plans a request may bill: preferred, signed in or keyed, and not
   * declined. The GLM Coding Plan is absent when a dashboard GLM endpoint
   * outranks its path.
   */
  readonly plans: readonly PlanRoute[];
  /**
   * The user's input window override, in tokens, for the ChatGPT
   * subscription; `undefined` takes the window the backend grants the model.
   */
  readonly chatgptContextWindow: number | undefined;
  /**
   * The host's endpoint per provider id: a dashboard URL, or the default of
   * the region the provider's toggle picks. A provider absent here takes its
   * plugin's default.
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
  /** The string as stored. */
  readonly id: string;
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

## turnCost

The cost of one turn, never negative. A plan route (ChatGPT/Codex, Grok,
the GLM coding plan, Kimi Code) is covered by the subscription, so every
rate is zero and a receipt the provider finalized bills an API key this turn
did not use. An API-key route bills the catalog's rates on its service
tier; a model with a long-context tier bills the whole request at it once
the prompt, cached tokens included, is above it (llm-zoo's
`requestRates`). An xAI receipt carries its own final cost, which wins
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
const TurnRequestSchema: Struct<{ readonly mode: optional<Literals<readonly ["foreground", "background"]>>; readonly system: optional<String>; readonly messages: $Array<Union<readonly [Struct<{ readonly role: Literal<"user">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>, Struct<{ readonly role: Literal<"assistant">; readonly origin: NullOr<Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; }>, Struct<{ readonly role: Literal<"tool">; readonly results: $Array<Struct<{ readonly callOrdinal: Int; readonly status: Literals<readonly ["success", "error"]>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literal<"image">; readonly detail: optional<Literals<readonly ["low", "medium", "high", "ultra-high"]>>; }>, Struct<{ readonly mimeType: String; readonly base64: String; readonly kind: Literals<readonly ["audio", "video", "document"]>; }>]>>; }>>; }>, Struct<{ readonly role: Literal<"system">; readonly text: String; }>]>>; readonly tools: optional<$Array<Struct<{ readonly name: String; readonly description: String; readonly parameters: compose<$Record<String, Codec<Json, Json, never, never>>, Unknown>; }>>>; readonly toolChoice: optional<Union<readonly [Literal<"auto">, Struct<{ readonly name: String; }>]>>; readonly maxOutputTokens: optional<Int>; readonly continuation: optional<Union<readonly [Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: String; readonly coveredSteps: Int; }>; }>, Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: String; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>]>>; readonly cacheKey: optional<String>; }>
```

## TurnResult

A completed provider turn: its content, finish reason and usage.

```ts
type TurnResult = typeof TurnResultSchema.Type;
```

## TurnResultSchema

A completed provider turn, not a completed agent execution.

```ts
const TurnResultSchema: Struct<{ readonly providerResponseId: NullOr<String>; readonly modelFingerprint: NullOr<String>; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"message">; readonly content: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"refusal">; readonly text: String; }>]>>; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-message">; readonly itemId: String; readonly status: Literals<readonly ["completed", "incomplete"]>; readonly phase: optional<NullOr<Literals<readonly ["commentary", "final_answer"]>>>; }>>; }>, Struct<{ readonly kind: Literal<"reasoning">; readonly summary: $Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>; readonly content: optional<$Array<Struct<{ readonly kind: Literal<"text">; readonly text: String; }>>>; readonly evidence: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions-thought-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"openai-responses-reasoning">; readonly itemId: String; readonly encryptedContent: optional<NullOr<String>>; readonly status: optional<Literals<readonly ["completed", "incomplete"]>>; }>, Struct<{ readonly kind: Literal<"anthropic-thinking-signature">; readonly signature: String; }>, Struct<{ readonly kind: Literal<"anthropic-redacted-thinking">; readonly data: String; }>]>>; }>, Struct<{ readonly kind: Literal<"local-call">; readonly providerCallId: String; readonly name: String; readonly argumentsText: String; readonly evidence: optional<Struct<{ readonly kind: Literal<"openai-responses-function-call">; readonly itemId: optional<String>; readonly status: optional<Literal<"completed">>; }>>; }>]>>; readonly finishReason: Literals<readonly ["stop", "length", "content-filter", "tool-calls", "refusal"]>; readonly finishEvidence: optional<Union<readonly [Struct<{ readonly kind: Literal<"google-interactions">; readonly status: String; readonly terminalReason: NullOr<String>; }>, Struct<{ readonly kind: Literal<"openai-responses">; readonly status: Literals<readonly ["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"]>; readonly incompleteReason: NullOr<Literals<readonly ["max_output_tokens", "content_filter"]>>; }>]>>; readonly refusalEvidence: optional<NullOr<Struct<{ readonly kind: Literal<"anthropic-refusal">; readonly category: NullOr<Literals<readonly ["cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms"]>>; readonly explanation: NullOr<String>; }>>>; readonly usage: NullOr<Struct<{ readonly inputTokens: NullOr<Int>; readonly outputTokens: NullOr<Int>; readonly totalTokens: NullOr<Int>; readonly cachedInputTokens: NullOr<Int>; readonly cacheWriteTokens: NullOr<Int>; readonly reasoningTokens: NullOr<Int>; readonly toolUsePromptTokens: NullOr<Int>; readonly providerUsage: optional<Union<readonly [Struct<{ readonly kind: Literal<"xai">; readonly costInUsdTicks: NullOr<Int>; }>, Struct<{ readonly kind: Literal<"anthropic">; readonly uncachedInputTokens: NullOr<Int>; readonly cacheCreation5mTokens: NullOr<Int>; readonly cacheCreation1hTokens: NullOr<Int>; }>]>>; }>>; readonly continuation: optional<Union<readonly [Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"google-interactions">; }>; readonly anchor: Struct<{ readonly interactionId: String; readonly coveredSteps: Int; }>; }>, Struct<{ readonly coveredMessages: Int; readonly prefixFingerprint: String; readonly origin: Struct<{ readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly requestedModel: String; readonly codecVersion: Int; readonly protocol: Literal<"openai-responses">; }>; readonly anchor: Struct<{ readonly responseId: String; readonly coveredItems: Int; readonly kind: Literal<"stored">; }>; }>]>>; readonly requestedOrigin: Struct<{ readonly requestedModel: String; readonly deployment: Struct<{ readonly endpoint: String; readonly credentialScope: String; }>; readonly protocol: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly codecVersion: Int; }>; readonly returnedModel: NullOr<String>; readonly kind: Literal<"http">; }>
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

The effort `route` sends for `config`: the chosen level, or `none` when
thinking is off and `none` is how the route says so.

```ts
function wireEffort(
  config: Pick<ModelConfig, 'provider' | 'reasoning'>,
  route: Pick<ModelRoute, 'kind'> | undefined,
  reasoning: ReasoningChoice,
): ReasoningEffort | null
```
