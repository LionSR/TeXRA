/**
 * Browser-safe entry of `@texra-ai/llm`: the turn contract, model and provider
 * catalogs, route decisions, reasoning selection, turn cost, and `ModelError`.
 *
 * > **Guide:** Read [Model Layer (`@texra-ai/llm`)](/api/model-layer) for how
 * > catalog selection, route resolution, `prepareTurn` / `streamTurn`, and
 * > `ModelError` work together.
 *
 * ### Key exports by role
 *
 * - **Turn contract**: [`Model`](#model) (`prepareTurn`, `streamTurn`),
 *   [`TurnRequest`](#turnrequest) ([`TurnRequestSchema`](#turnrequestschema)),
 *   [`ResolvedTurn`](#resolvedturn), [`TurnEvent`](#turnevent),
 *   [`TurnResult`](#turnresult), and [`completedTurn`](#completedturn).
 * - **Model & provider catalogs**: [`selectModel`](#selectmodel),
 *   [`MODEL_PROVIDER_PLUGINS`](#model_provider_plugins),
 *   [`decideModelRoute`](#decidemodelroute),
 *   [`resolveRouteEndpoint`](#resolverouteendpoint),
 *   [`RouteFacts`](#routefacts) ([`OWN_KEY_ROUTE_FACTS`](#own_key_route_facts)),
 *   [`chooseReasoning`](#choosereasoning), and [`turnCost`](#turncost).
 * - **Structured failures & credentials**: [`ModelError`](#modelerror),
 *   [`ModelErrorFields`](#modelerrorfields), and
 *   [`CredentialStore`](#credentialstore).
 *
 * Binding a model to its wire protocol (`bindModel`) and running subscription
 * OAuth flows live in [`@texra-ai/llm/node`](./node).
 */

// The turn contract: request, result, events and the `Model` that runs a turn.
export {
  assistantMessageFromResult,
  completedTurn,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
} from './turn.js';
export type {
  BackgroundEvent,
  BackgroundSubmission,
  FileUpload,
  Model,
  ResolvedTurn,
  TurnEvent,
  TurnRequest,
  TurnResult,
  TurnUsage,
  UnreleasedUpload,
} from './turn.js';
export {
  checkPreparedHistory,
  JsonObjectSchema,
  ModelOriginSchema,
  originOf,
  sameModelOrigin,
  TurnProtocolSchema,
} from './protocol.js';
export type { ModelOrigin, PreparedHistoryEntry } from './protocol.js';
export {
  AssistantMessageSchema,
  MessageSchema,
  PreparedHistorySchema,
  systemUpdateText,
} from './message.js';
export type { AssistantMessage, Continuation } from './message.js';
export { ModelError, RemoteOperationSchema } from './errors.js';
export type {
  BillingRoute,
  ModelErrorFields,
  PlanRoute,
  RemoteOperation,
} from './errors.js';

// Credentials and the provider manifest over llm-zoo.
export { resolveCredential, SecretsFailed } from './providers/credentials.js';
export type {
  CredentialOrigin,
  CredentialStore,
  SecretsOperation,
} from './providers/credentials.js';
export {
  BACKEND_PROTOCOLS,
  findModelProviderPlugin,
  MODEL_PROVIDER_PLUGINS,
} from './providers/providerPlugins.js';
export type {
  ApiKeyProviderId,
  BackendProviderId,
  EndpointProviderId,
  ModelProviderPlugin,
  RegionalBaseUrl,
  RegionalProviderId,
} from './providers/providerPlugins.js';
export {
  API_KEY_ENV_NAMES,
  API_KEY_PROVIDER_IDS,
  apiKeyEnvName,
  providerDisplayName,
} from './providers/providers.js';
export {
  apiKeySecretName,
  apiProviderOfSecretName,
  exposeApiKey,
  hasUsableApiKey,
  isApiProvider,
  loadApiKeyStatusMap,
  lookupApiKey,
  lookupApiKeyOrigin,
} from './providers/apiProviders.js';
export type { ApiKeyStatus } from './providers/apiProviders.js';

// Choosing a model: selection, the route decision, reasoning and pricing.
export {
  modelConfig,
  modelRefOf,
  selectModel,
} from './models/modelSelection.js';
export type { SelectedModel } from './models/modelSelection.js';
export {
  codexBackendModelId,
  decideModelRoute,
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  isUnservedModel,
  OWN_KEY_ROUTE_FACTS,
  resolveModelSource,
  routeConfig,
  zeroCostAccessOverrides,
} from './models/modelRoute.js';
export type {
  ApiKeyUsageRoute,
  HostRouteFacts,
  ModelRoute,
  RouteDecisionFacts,
  RouteFacts,
} from './models/modelRoute.js';
export { resolveRouteEndpoint } from './models/routeEndpoint.js';
export {
  acceptedEfforts,
  chooseReasoning,
  CODEX_ROUTE_EFFORTS,
  defaultReasoningLevel,
  ReasoningChoiceError,
  wireEffort,
} from './models/reasoningChoice.js';
export type {
  ChooseReasoningOptions,
  ReasoningChoice,
  ReasoningRequest,
} from './models/reasoningChoice.js';
export { turnCost } from './models/turnCost.js';
