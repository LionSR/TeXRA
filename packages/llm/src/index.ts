/**
 * `@texra-ai/llm` — the browser-safe entry: everything a caller reads to
 * choose a model and run a turn, with no Node module and no vendor SDK behind
 * it, so the webviews and the desktop renderer import it as freely as the
 * hosts do. Each name below has a consumer outside the package or is a type
 * a public signature names (`RouteFacts`); a file's other exports stay
 * package-internal.
 *
 * Binding a model to its wire protocol, and the subscription sign-in flows,
 * run in Node and live at `@texra-ai/llm/node`.
 */

// The turn contract: request, result, events and the `Model` that runs a turn.
export {
  assistantMessageFromResult,
  completedTurn,
  ResolvedTurnSchema,
  TurnEventSchema,
  TurnRequestSchema,
  TurnResultSchema,
  VscodeLanguageModelConfigurationSchema,
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
export type { AssistantMessage, Continuation } from './message.js';
export {
  ModelError,
  ModelErrorFieldsSchema,
  RemoteOperationSchema,
} from './errors.js';
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
} from './models/reasoningChoice.js';
export type {
  ChooseReasoningOptions,
  ReasoningChoice,
  ReasoningRequest,
} from './models/reasoningChoice.js';
export { turnCost } from './models/turnCost.js';
