/**
 * `@texra-ai/llm` — the browser-safe entry: everything a caller reads to
 * choose a model and run a turn, with no Node module and no vendor SDK behind
 * it, so the webviews and the desktop renderer import it as freely as the
 * hosts do. Each name below has a consumer outside the package; a file's
 * other exports stay package-internal.
 *
 * Binding a model to its wire protocol, and the subscription sign-in flows,
 * run in Node and live at `@texra-ai/llm/node`.
 */

// The turn contract: request, result, events and the `Model` that runs a turn.
export {
  assistantMessageFromResult,
  CancellationEvidenceSchema,
  completedTurn,
  TurnRequestSchema,
  TurnResultSchema,
  VscodeLanguageModelConfigurationSchema,
} from './turn.js';
export type {
  BackgroundEvent,
  CancellationEvidence,
  Model,
  ResolvedTurn,
  TurnEvent,
  TurnRequest,
  TurnResult,
  VscodeLanguageModelConfiguration,
} from './turn.js';
export {
  JsonObjectSchema,
  ModelOriginSchema,
  originOf,
  sameModelOrigin,
  TurnProtocolSchema,
} from './protocol.js';
export type { ModelOrigin } from './protocol.js';
export {
  MessageSchema,
  PreparedHistorySchema,
  systemUpdateText,
} from './message.js';
export type { Continuation } from './message.js';
export { ModelError, RemoteOperationSchema } from './errors.js';
export type { RemoteOperation } from './errors.js';

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
  configuredApiKeyProviders,
  exposeApiKey,
  getApiKey,
  hasUsableApiKey,
  isApiProvider,
  loadApiKeyStatusMap,
  lookupApiKey,
  lookupApiKeyOrigin,
} from './providers/apiProviders.js';
export type { ApiKeyStatus } from './providers/apiProviders.js';

// Choosing a model: selection, the route decision, reasoning and pricing.
export {
  isDeprecatedModel,
  isRetiredModel,
  modelConfig,
  modelRefOf,
  selectModel,
} from './models/modelSelection.js';
export type { SelectedModel } from './models/modelSelection.js';
export {
  codexBackendModelId,
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  routeConfig,
} from './models/modelRoute.js';
export type {
  HostRouteFacts,
  ModelRoute,
  RouteFacts,
} from './models/modelRoute.js';
export { resolveRouteEndpoint } from './models/routeEndpoint.js';
export { resolveModelSource } from './models/openRouterRouting.js';
export {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from './models/kimiCodeRetryGate.js';
export {
  acceptedEfforts,
  chooseReasoning,
  CODEX_ROUTE_EFFORTS,
  defaultReasoningLevel,
  ReasoningChoiceError,
} from './models/reasoningChoice.js';
export type {
  ChooseReasoningOptions,
  ReasoningChoice,
  ReasoningRequest,
} from './models/reasoningChoice.js';
export { zeroCostAccessOverrides } from './models/subscriptionAccessOverrides.js';
export { turnCost } from './models/turnCost.js';
