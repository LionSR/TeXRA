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
  prefersCopilotRoute,
} from '@model/copilotRouting';
import {
  codexBackendModelId,
  type ProviderCapabilityProfile,
  resolveCodexSubscriptionCapabilities,
  resolveXaiSubscriptionCapabilities,
} from '@model/providerCapabilities';
import { isCodexSignedIn } from '@model/codex/codexSubscription';
import { isXaiSignedIn } from '@model/xai/xaiSubscription';
import {
  resolveDirectModelApiKeyProvider,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { exposeApiKey, getApiKey, type ApiProvider } from '@model/apiProviders';
import { resolveRouteEndpoint } from '@model/routeEndpoint';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  DeclinableUsageRoute,
  ModelCompatibilityKey,
  UsageRoute,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { findModelProviderPlugin } from '@shared/constants/modelProviderPlugins';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'modelRoutes';

/**
 * The Grok subscription's OAuth token is accepted by xAI's own API surface
 * only; it is never sent to a dashboard custom endpoint or OpenRouter.
 */
const XAI_SUBSCRIPTION_ENDPOINT = 'https://api.x.ai/v1';

/**
 * Check if OpenAI Responses API should be used for this config. Talking to
 * OpenAI directly always means Responses: the OpenAI-direct Chat Completions
 * route is gone. The only non-Responses OpenAI route left is OpenRouter,
 * which proxies these models on /v1/chat/completions and rejects
 * Responses-shaped payloads — so an OpenRouter-only config, or any config
 * under the global OpenRouter preference, falls through to
 * {@link shouldRouteModelThroughOpenRouter} below. A model that requires
 * Responses has no OpenRouter route at all and stays on Responses.
 */
function shouldUseResponsesAPI(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.provider !== ModelProvider.OPENAI || config.openRouterOnly) {
    return false;
  }
  return config.requiresResponsesAPI === true || !useOpenRouter;
}

/**
 * Single owner for the "prefer short model names" preference read. Read live
 * (no caching) so a mid-session settings change is honored on the next
 * binding, matching the other `globalState` reads in this module.
 */
const getPreferShortModelNames = Effect.fn('getPreferShortModelNames')(
  function* (globalState: StateStore) {
    return yield* globalState.get<boolean>(
      GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
      false,
    );
  },
);

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

/** The route a subscription-eligible model binds under, with its own config. */
interface SubscriptionRoute {
  readonly credential: SubscriptionRouteCredential;
  readonly config: ModelConfig;
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

/** One OAuth subscription a model provider's API key can give way to. */
interface SubscriptionRouteRow {
  readonly route: SubscriptionSession['route'];
  /** The subscription's name in the signed-out warning ('ChatGPT'). */
  readonly subscriptionName: string;
  /** The API key the model bills while signed out ('OpenAI'). */
  readonly apiKeyName: string;
  /** The route's own config (context ceiling, zero price), or null when the
   *  preference is off, OpenRouter is selected, the model is OpenRouter-only,
   *  or the model is not eligible. */
  readonly resolveCapabilities: (
    stores: SettingsStores,
    config: ModelConfig,
    useOpenRouter: boolean,
  ) => Effect.Effect<ProviderCapabilityProfile | null, Error>;
  readonly isSignedIn: () => Effect.Effect<boolean>;
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
 * The subscription routes, keyed by the model provider whose API key each
 * stands in for. A subscription is one row here; the resolver below never
 * names a provider.
 *
 * Each binding calls through rather than capturing the imported value: the
 * table is built at module load, and a suite that partially mocks
 * `@auth/*` or the model-layer subscription modules must still load this one.
 */
const SUBSCRIPTION_ROUTES: ReadonlyMap<ModelProvider, SubscriptionRouteRow> =
  new Map([
    [
      ModelProvider.OPENAI,
      {
        route: 'chatgpt-subscription',
        subscriptionName: 'ChatGPT',
        apiKeyName: 'OpenAI',
        resolveCapabilities: (stores, config, useOpenRouter) =>
          resolveCodexSubscriptionCapabilities(stores, config, useOpenRouter),
        isSignedIn: () => isCodexSignedIn(),
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
    ],
    [
      ModelProvider.XAI,
      {
        route: 'xai-subscription',
        subscriptionName: 'Grok',
        apiKeyName: 'xAI',
        resolveCapabilities: (stores, config, useOpenRouter) =>
          resolveXaiSubscriptionCapabilities(stores, config, useOpenRouter),
        isSignedIn: () => isXaiSignedIn(),
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
    ],
  ]);

/**
 * The subscription route a model binds under, if the user prefers one, the
 * model is eligible on it, and a session is signed in. Decided above
 * {@link resolveRouteCredential}: an eligible model with the preference on
 * but no signed-in session falls back to the API key, and says so, because
 * the preference is a preference (the model list already shows which route
 * serves the model), while a signed-in session that fails to refresh is a
 * failure and surfaces as one. The returned config is the route's own: the
 * subscription's context ceiling and its zero per-token price. A run that
 * declined this route (a retry the user answered with their own API key)
 * never reaches it, whatever the stored preference says.
 */
export const resolveSubscriptionCredential = Effect.fn(
  'resolveSubscriptionCredential',
)(function* (
  stores: SettingsStores,
  config: ModelConfig,
  useOpenRouter: boolean,
  secrets: PlatformSecrets,
  declinedRoutes: readonly DeclinableUsageRoute[] = [],
): Effect.fn.Return<SubscriptionRoute | null, Error, HttpClient.HttpClient> {
  const provider = resolveDirectModelApiKeyProvider(config);
  if (provider === undefined) return null;
  const row = SUBSCRIPTION_ROUTES.get(config.provider);
  if (row === undefined || declinedRoutes.includes(row.route)) return null;
  // The capability read consults the subscription preference and
  // context-window setting of the workspace the caller handed in; a host
  // read that throws stays in the typed channel.
  const profile = yield* row.resolveCapabilities(stores, config, useOpenRouter);
  if (profile === null) return null;
  const signedIn = yield* row.isSignedIn();
  if (!signedIn) {
    yield* Effect.logWarning(
      `Prefer ${row.subscriptionName} subscription is on but no ${row.subscriptionName} session is signed in: model ${config.name} bills the ${row.apiKeyName} API key.`,
    ).pipe(withLogChannel(CHANNEL));
    return null;
  }
  const session = yield* row
    .readSession(secrets, config)
    .pipe(Effect.mapError(row.authFailure));
  return {
    credential: { ...session, provider },
    config: profile.config,
  };
});

/**
 * Resolve the credential and endpoint the run loop binds a model under: the
 * direct API key of the model's provider, or the OpenRouter key when the
 * route goes through OpenRouter. The one producer of the missing-credential
 * fact the run lifecycle classifies for the loop, so the failure carries the
 * typed marker rather than a message pattern. Lives beside the route resolver
 * above so route and credential are decided in one place. `secrets` is the
 * process secret store the caller already holds.
 *
 * A program, because the key read behind it is one ({@link getApiKey}). The
 * endpoint resolution is a synchronous host read — a per-provider dashboard
 * endpoint, the China-region switch — over `stores`, the setting slots of the
 * workspace the caller holds.
 */
export const resolveRouteCredential = Effect.fn('resolveRouteCredential')(
  function* (
    stores: SettingsStores,
    config: ModelConfig,
    useOpenRouter: boolean,
    secrets: PlatformSecrets,
    declinedRoutes?: readonly DeclinableUsageRoute[],
  ) {
    const provider = useOpenRouter
      ? 'openRouter'
      : resolveDirectModelApiKeyProvider(config);
    if (!provider) {
      return yield* Effect.fail(
        new Error(`Model "${config.name}" has no direct API-key provider.`),
      );
    }
    // An unreadable key store fails as itself, not as a missing key.
    const apiKey = yield* getApiKey(secrets, provider).pipe(
      Effect.map(exposeApiKey),
      Effect.catchTag('ApiKeyMissing', (cause) => {
        const error = new Error(
          useOpenRouter
            ? 'Missing OpenRouter API key. Set an OpenRouter API key in settings.'
            : `Missing API key for ${provider}. Set a provider API key in settings.`,
          { cause },
        );
        attachMissingApiKeyError(error);
        return Effect.fail(error);
      }),
    );
    const endpoint = yield* resolveRouteEndpoint(
      stores,
      config,
      useOpenRouter,
      declinedRoutes,
    );
    return {
      apiKey,
      endpoint: endpoint.baseUrl,
      provider,
      route: useOpenRouter ? 'openrouter' : 'api-key',
      usageRoute:
        endpoint.usageRoute ??
        (provider === 'kimiCode' ? 'kimi-code-subscription' : 'api-key'),
    } satisfies ApiKeyRouteCredential;
  },
);

/**
 * The config a binding sends on the wire under the user's "prefer short model
 * names" setting: the unpinned `shortName` in place of the date-pinned
 * `fullName`, for gateways that accept only the unpinned identifier. Applied
 * to the bound config, not only to the route decision, so the request carries
 * the identifier the preference promises.
 */
export const withShortModelName = Effect.fn('withShortModelName')(function* (
  config: ModelConfig,
  globalState: StateStore,
) {
  const resolved = applyShortModelNamePreference(
    config,
    yield* getPreferShortModelNames(globalState),
  );
  if (resolved !== config) {
    yield* Effect.logDebug(
      `Using short model name for ${config.name}: ${config.fullName} → ${resolved.fullName}`,
    ).pipe(withLogChannel(CHANNEL));
  }
  return resolved;
});

function applyShortModelNamePreference(
  config: ModelConfig,
  preferShortModelNames: boolean,
): ModelConfig {
  if (!preferShortModelNames) return config;
  // Mode-selected registry entries share another entry's wire id. Their
  // display-oriented shortName is not an API model identifier.
  if (config.capabilities.reasoningMode !== undefined) return config;
  const short = config.shortName;
  if (!short || short === config.fullName) return config;
  return { ...config, fullName: short };
}

/** Returns the conversation-history format this model binds under. */
export const resolveModelCompatibilityKey = Effect.fn(
  'resolveModelCompatibilityKey',
)(function* (
  originalConfig: ModelConfig,
  globalState: StateStore,
  useOpenRouter: boolean,
  ownApiKeyFallback = false,
) {
  if (yield* shouldUseInternalValidationModel()) {
    return 'Validation';
  }

  // Editor-supplied models cannot be proxied through OpenRouter. Both Copilot
  // routes — the per-model route preference on a canonical base model, and a
  // config whose provider is Copilot itself — must win before the global
  // OpenRouter preference below. A preference is a hard route choice: when
  // the editor cannot serve it right now, report the route state instead of
  // silently consuming a provider key or subscription (#9635).
  if (
    !ownApiKeyFallback &&
    (yield* prefersCopilotRoute(originalConfig.name, globalState))
  ) {
    const unavailableReason = yield* copilotRouteUnavailableReason(
      originalConfig.name,
      globalState,
    );
    if (unavailableReason)
      return yield* Effect.fail(new AgentError(unavailableReason));
    return 'VscodeLm';
  }
  if (originalConfig.provider === ModelProvider.COPILOT) {
    return 'VscodeLm';
  }

  // Re-application is identity on an already-shortened config, so the live
  // `bindModel` path can hand this its own resolved config.
  const config = applyShortModelNamePreference(
    originalConfig,
    yield* getPreferShortModelNames(globalState),
  );
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    return 'OpenAIResponse';
  }
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'OpenRouterNative';
  }
  return yield* providerCompatibilityKey(config.provider);
});

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
