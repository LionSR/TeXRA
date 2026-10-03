/**
 * `@texra-ai/llm` — the browser-safe entry: everything a caller reads to
 * choose and describe a model, with no Node module and no vendor SDK behind
 * it, so the webviews and the desktop renderer import it as freely as the
 * hosts do.
 *
 * - the turn contract: the `Model` interface, the request, configuration,
 *   result and event schemas, and `ModelError`;
 * - the provider catalog over llm-zoo: the provider plugins, the API-key
 *   providers and their key lookup over a `CredentialStore`, the coding
 *   plans;
 * - the route decision: `RouteFacts`, `decideModelRoute`, `routeConfig`,
 *   the endpoint of a route, OpenRouter routing, the reasoning choice, the
 *   picker's base option fields.
 *
 * Binding a configuration to its wire protocol, and the subscription
 * sign-in flows, run in Node and live at `@texra-ai/llm/node`.
 */
export * from './turn.js';

export * from './providers/credentials.js';
export * from './providers/providerPlugins.js';
export * from './providers/providers.js';
export * from './providers/apiProviders.js';
export * from './providers/codingPlanSubscriptions.js';

export * from './models/modelSelection.js';
export * from './models/modelRoute.js';
export * from './models/routeEndpoint.js';
export * from './models/openRouterRouting.js';
export * from './models/kimiCodeRetryGate.js';
export * from './models/providerCapabilities.js';
export * from './models/reasoningChoice.js';
export * from './models/modelOptionsBasic.js';
export * from './models/subscriptionAccessOverrides.js';

export { codexAccountLabel } from './oauth/codex/codexSessionTypes.js';
export { xaiAccountLabel } from './oauth/xai/xaiSessionTypes.js';
