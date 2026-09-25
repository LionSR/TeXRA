import { Effect } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { shouldUseInternalValidationModel } from '@agent/runtime/run/validationModel';
import {
  CODEX_BACKEND_BASE_URL,
  CodexAuthError,
  codexCoordinator,
  formatCodexAuthUnavailableMessage,
} from '@auth/codex';
import {
  XaiAuthError,
  formatXaiAuthUnavailableMessage,
  xaiCoordinator,
} from '@auth/xai';
import { AgentError } from '@common/errors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import { withLogChannel } from '@logger/effectLog';
import {
  copilotRouteUnavailableReason,
  discoverCopilotRoutes,
  prefersCopilotRoute,
  type CopilotModelRoute,
} from '@model/copilotRouting';
import { codexBackendModelId } from '@model/providerCapabilities';
import { exposeApiKey, getApiKey, type ApiProvider } from '@model/apiProviders';
import {
  decideModelRoute,
  readRouteFacts,
  type ModelRoute,
} from '@model/modelRoute';
import { resolveRouteEndpoint } from '@model/routeEndpoint';
import type { StateStore } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  DeclinableUsageRoute,
  ModelCompatibilityKey,
  UsageRoute,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { findModelProviderPlugin } from '@shared/constants/modelProviderPlugins';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'modelRoutes';

/**
 * The Grok subscription's OAuth token is accepted by xAI's own API surface
 * only; it is never sent to a dashboard custom endpoint or OpenRouter.
 */
const XAI_SUBSCRIPTION_ENDPOINT = 'https://api.x.ai/v1';

/** The API-key credential and endpoint of one model route, resolved together. */
export interface ApiKeyRouteCredential {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly provider: ApiProvider;
  readonly route: 'api-key' | 'openrouter';
  readonly usageRoute: UsageRoute;
}

/**
 * What a subscription route reads off its signed-in session: the ChatGPT
 * (Codex) session on the Responses protocol, the Grok session on the xAI Chat
 * protocol, each with the endpoint its token is accepted at. The token is the
 * bearer the package sends; `@auth/*` owns its refresh, so a binding always
 * carries a fresh one.
 */
type SubscriptionSession =
  | {
      readonly route: 'chatgpt-subscription';
      readonly accessToken: string;
      readonly accountId: string | null;
      /** The ChatGPT plan the session's token names, when it names one. It
       *  is display-only: the backend decides what the plan may call. */
      readonly plan: string | undefined;
      /** The Codex backend's bare model id, which differs from the API's. */
      readonly requestedModel: string;
      readonly endpoint: string;
      readonly usageRoute: 'chatgpt-subscription';
    }
  | {
      readonly route: 'xai-subscription';
      readonly accessToken: string;
      readonly endpoint: string;
      readonly usageRoute: 'xai-subscription';
    };

/** An OAuth subscription session standing in for the provider's API key. */
type SubscriptionRouteCredential = SubscriptionSession & {
  readonly provider: ApiProvider;
};

export type RouteCredential =
  ApiKeyRouteCredential | SubscriptionRouteCredential;

/** The bearer secret of a route, whichever credential kind carries it. */
export function routeBearer(credential: RouteCredential): string {
  switch (credential.route) {
    case 'api-key':
    case 'openrouter':
      return credential.apiKey;
    case 'chatgpt-subscription':
    case 'xai-subscription':
      return credential.accessToken;
  }
}

/**
 * A subscription session failure the user must act on, minted as the loop's
 * own error: the "sign in again, or turn off the preference" instruction, not
 * a raw auth error. Anything else keeps its identity.
 */
function subscriptionAuthFailure<E extends Error>(
  error: Error,
  AuthError: abstract new (...args: never[]) => E,
  format: (error: E) => string,
): Error {
  return error instanceof AuthError
    ? new AgentError(format(error), { cause: error })
    : error;
}

/** How one OAuth subscription route reads its signed-in session. */
interface SubscriptionRouteRow {
  /** The API key the subscription stands in for. */
  readonly provider: ApiProvider;
  /**
   * The session read, the only refresh on this path. Its failure passes
   * through `authFailure`, so a refresh that fails reaches the user as the
   * "sign in again, or turn off the preference" instruction.
   */
  readonly readSession: (
    secrets: PlatformSecrets,
    config: ModelConfig,
  ) => Effect.Effect<SubscriptionSession, Error, HttpClient.HttpClient>;
  readonly authFailure: (error: Error) => Error;
}

/**
 * The subscription routes, keyed by the route kind `decideModelRoute`
 * decided. Eligibility, the preference and the sign-in are the decision's;
 * a row only reads the session.
 *
 * Each binding calls through rather than capturing the imported value: the
 * table is built at module load, and a suite that partially mocks
 * `@auth/*` must still load this one.
 */
const SUBSCRIPTION_ROUTES: {
  readonly [K in SubscriptionSession['route']]: SubscriptionRouteRow;
} = {
  'chatgpt-subscription': {
    provider: 'openai',
    readSession: (secrets, config) =>
      Effect.gen(function* () {
        const coordinator = codexCoordinator(secrets);
        const accessToken = yield* coordinator.getFreshAccessToken();
        const accountId = (yield* coordinator.getAccountId()) ?? null;
        const plan = yield* coordinator.getPlanType();
        return {
          route: 'chatgpt-subscription',
          accessToken,
          accountId,
          plan,
          requestedModel: codexBackendModelId(config),
          endpoint: CODEX_BACKEND_BASE_URL,
          usageRoute: 'chatgpt-subscription',
        } as const;
      }),
    authFailure: (error) =>
      subscriptionAuthFailure(
        error,
        CodexAuthError,
        formatCodexAuthUnavailableMessage,
      ),
  },
  'xai-subscription': {
    provider: 'xai',
    readSession: (secrets) =>
      Effect.map(
        xaiCoordinator(secrets).getFreshAccessToken(),
        (accessToken) =>
          ({
            route: 'xai-subscription',
            accessToken,
            endpoint: XAI_SUBSCRIPTION_ENDPOINT,
            usageRoute: 'xai-subscription',
          }) as const,
      ),
    authFailure: (error) =>
      subscriptionAuthFailure(
        error,
        XaiAuthError,
        formatXaiAuthUnavailableMessage,
      ),
  },
};

/**
 * The OAuth session a subscription route bills. The decision already found
 * the preference on, the model eligible and a session signed in, so this
 * only reads the session; a signed-in session that fails to refresh is a
 * failure and surfaces as one.
 */
export const resolveSubscriptionCredential = Effect.fn(
  'resolveSubscriptionCredential',
)(function* (
  config: ModelConfig,
  route: Extract<ModelRoute, { kind: SubscriptionSession['route'] }>,
  secrets: PlatformSecrets,
): Effect.fn.Return<SubscriptionRouteCredential, Error, HttpClient.HttpClient> {
  const row = SUBSCRIPTION_ROUTES[route.kind];
  const session = yield* row
    .readSession(secrets, config)
    .pipe(Effect.mapError(row.authFailure));
  return { ...session, provider: row.provider };
});

/**
 * Resolve the key and endpoint of an API-key route: the provider key the
 * decision named, or the OpenRouter key. The one producer of the
 * missing-credential fact the run lifecycle classifies for the loop, so the
 * failure carries the typed marker rather than a message pattern. `secrets`
 * is the process secret store the caller already holds; the endpoint is read
 * over `stores`, the setting slots of the workspace the caller holds.
 */
export const resolveRouteCredential = Effect.fn('resolveRouteCredential')(
  function* (
    stores: SettingsStores,
    config: ModelConfig,
    route: Extract<
      ModelRoute,
      { kind: 'openrouter' | 'api-key' | 'no-api-key' }
    >,
    secrets: PlatformSecrets,
  ) {
    if (route.kind === 'no-api-key') {
      return yield* Effect.fail(
        new Error(`Model "${config.name}" has no direct API-key provider.`),
      );
    }
    const provider =
      route.kind === 'openrouter' ? 'openRouter' : route.provider;
    // An unreadable key store fails as itself, not as a missing key.
    const apiKey = yield* getApiKey(secrets, provider).pipe(
      Effect.map(exposeApiKey),
      Effect.catchTag('ApiKeyMissing', (cause) => {
        const error = new Error(
          route.kind === 'openrouter'
            ? 'Missing OpenRouter API key. Set an OpenRouter API key in settings.'
            : `Missing API key for ${provider}. Set a provider API key in settings.`,
          { cause },
        );
        attachMissingApiKeyError(error);
        return Effect.fail(error);
      }),
    );
    return {
      apiKey,
      endpoint: yield* resolveRouteEndpoint(stores, config, route),
      provider,
      route: route.kind,
      usageRoute: route.kind === 'openrouter' ? 'api-key' : route.usageRoute,
    } satisfies ApiKeyRouteCredential;
  },
);

/**
 * The routes a binding can take: the unsupported one fails in resolution, and
 * a Copilot route binds only with the editor route discovered for it.
 */
export type BindableRoute =
  | Exclude<ModelRoute, { kind: 'openrouter-unsupported' | 'copilot' }>
  | { readonly kind: 'copilot'; readonly route: CopilotModelRoute };

/**
 * The route `config` binds under, decided once over this workspace's facts.
 * A resumed conversation's persisted format constrains the facts it answers
 * for: its OpenRouter, Copilot and validation choice are the format's, and a
 * subscription serves it only on the protocol the format names, so turning a
 * preference on since cannot silently move the conversation's billing. An
 * own-key quota fallback declines the Copilot preference. When the decision
 * can land on Copilot, the editor's routes are discovered here, once, and the
 * decided route carries the one it found; a discovery failure fails the
 * decision as the host's error. The routes nothing can bind fail here as the
 * user's instruction: a mode-selected model on OpenRouter, and a Copilot
 * route the editor cannot serve now.
 */
export const resolveModelRoute = Effect.fn('resolveModelRoute')(function* (
  stores: SettingsStores & {
    readonly secrets: PlatformSecrets;
    readonly globalState: StateStore;
  },
  config: ModelConfig,
  options: {
    readonly compatibilityKey?: ModelCompatibilityKey | null;
    readonly ownApiKeyFallback?: boolean;
    readonly declinedRoutes?: readonly DeclinableUsageRoute[];
  } = {},
): Effect.fn.Return<BindableRoute, Error, LanguageModel> {
  const host = yield* readRouteFacts(stores, options.declinedRoutes);
  const key = options.compatibilityKey;
  const prefersCopilot =
    key == null
      ? !options.ownApiKeyFallback &&
        (yield* prefersCopilotRoute(config.name, stores.globalState))
      : key === 'VscodeLm';
  const copilotRoute =
    prefersCopilot || config.provider === ModelProvider.COPILOT
      ? (yield* discoverCopilotRoutes()).get(config.name)
      : undefined;
  const route = decideModelRoute(
    config,
    key == null
      ? {
          ...host,
          validation: yield* shouldUseInternalValidationModel(),
          prefersCopilot,
          copilotRoute,
        }
      : {
          ...host,
          validation: key === 'Validation',
          prefersCopilot,
          copilotRoute,
          useOpenRouter: key === 'OpenRouterNative',
          chatgptSubscription:
            host.chatgptSubscription && key === 'OpenAIResponse',
          xaiSubscription: host.xaiSubscription && key === 'XAI',
        },
  );
  if (route.kind === 'openrouter-unsupported') {
    return yield* Effect.fail(
      new Error(
        `Model ${config.name} requires reasoning mode ${config.capabilities.reasoningMode}, which OpenRouter does not support. Disable OpenRouter and use the provider API directly.`,
      ),
    );
  }
  if (route.kind !== 'copilot') return route;
  // A fresh run needs the editor to allow the route; a resumed conversation
  // keeps its format and binds whatever route the editor offers.
  const unavailableReason =
    key == null
      ? copilotRouteUnavailableReason(config.name, route.route)
      : undefined;
  if (unavailableReason) {
    return yield* Effect.fail(new AgentError(unavailableReason));
  }
  if (route.route === undefined) {
    return yield* Effect.fail(
      new Error(
        `No editor route is discovered for model ${config.name}; refresh the model list.`,
      ),
    );
  }
  return { kind: 'copilot', route: route.route };
});

/**
 * The config a binding sends on the wire under the user's "prefer short model
 * names" setting: the unpinned `shortName` in place of the date-pinned
 * `fullName`, for gateways that accept only the unpinned identifier. Applied
 * to the bound config, not only to the route decision, so the request carries
 * the identifier the preference promises.
 */
export const withShortModelName = Effect.fn('withShortModelName')(function* (
  config: ModelConfig,
  stores: SettingsStores,
) {
  const short = config.shortName;
  if (
    // Read live so a mid-session change is honored on the next binding.
    !(yield* readSettingFrom<boolean>(
      stores,
      GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    )) ||
    // Mode-selected registry entries share another entry's wire id. Their
    // display-oriented shortName is not an API model identifier.
    config.capabilities.reasoningMode !== undefined ||
    !short ||
    short === config.fullName
  ) {
    return config;
  }
  yield* Effect.logDebug(
    `Using short model name for ${config.name}: ${config.fullName} → ${short}`,
  ).pipe(withLogChannel(CHANNEL));
  return { ...config, fullName: short };
});

/**
 * The conversation-history format a route binds under. Talking to OpenAI
 * directly always means Responses (the OpenAI-direct Chat Completions route
 * is gone); OpenRouter proxies on its own chat format.
 */
export function routeCompatibilityKey(
  config: ModelConfig,
  route: BindableRoute,
): Effect.Effect<ModelCompatibilityKey | undefined> {
  switch (route.kind) {
    case 'validation':
      return Effect.succeed('Validation');
    case 'copilot':
      return Effect.succeed('VscodeLm');
    case 'openrouter':
      return Effect.succeed('OpenRouterNative');
    default:
      return config.provider === ModelProvider.OPENAI && !config.openRouterOnly
        ? Effect.succeed('OpenAIResponse')
        : providerCompatibilityKey(config.provider);
  }
}

/**
 * Guarded plugin read. The provider plugin manifest gives every
 * `ModelProvider` a compatibility key (checked at compile time), so a miss
 * means a provider string from outside the enum (stale registry entry or
 * persisted config). Report it here instead of crashing on the property
 * access; the caller turns the missing route into a named failure.
 */
function providerCompatibilityKey(
  provider: ModelProvider,
): Effect.Effect<ModelCompatibilityKey | undefined> {
  const key = findModelProviderPlugin(provider)?.compatibilityKey;
  if (key) return Effect.succeed(key);
  return Effect.logWarning(
    `No model route is registered for provider ${provider}`,
  ).pipe(withLogChannel(CHANNEL), Effect.as(undefined));
}
