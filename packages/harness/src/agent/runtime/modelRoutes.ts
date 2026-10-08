import { Effect } from 'effect';
import { ModelProvider, type ModelConfig, type ReasoningMode } from 'llm-zoo';

import {
  CODEX_BACKEND_BASE_URL,
  codexCoordinator,
  SubscriptionOAuthError,
  xaiCoordinator,
} from '@texra-ai/llm/node';
import {
  type ApiKeyProviderId,
  decideModelRoute,
  exposeApiKey,
  getApiKey,
  type ModelRoute,
  resolveRouteEndpoint,
  type HostRouteFacts,
  type RouteFacts,
} from '@texra-ai/llm';
import { shouldUseInternalValidationModel } from '@agent/runtime/run/validationModel';
import { AgentError } from '@common/errors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import { withLogChannel } from '@logger/effectLog';
import {
  copilotRouteUnavailableReason,
  discoverCopilotRoutes,
  prefersCopilotRoute,
  type CopilotModelRoute,
} from '@model/copilotRouting';
import { readRouteFacts } from '@model/modelRoute';
import type { StateStore } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import {
  ModelBackendSchema,
  type DeclinableUsageRoute,
  type ModelBackend,
  type UsageRoute,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SUBSCRIPTION_AUTH_COPY } from '@shared/model/accountAuth';
import { readSettingFrom } from '@utils/config/platformSettings';
import type { HttpClient } from 'effect/http';

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
  readonly provider: ApiKeyProviderId;
  readonly route: 'api-key' | 'openrouter';
  readonly usageRoute: UsageRoute;
}

/**
 * What a subscription route reads off its signed-in session: the ChatGPT
 * (Codex) session on the Responses protocol, the Grok session on the xAI Chat
 * protocol, each with the endpoint its token is accepted at. The token is the
 * bearer the package sends; `@texra-ai/llm/node` owns its refresh, so a binding always
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
  readonly provider: ApiKeyProviderId;
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
function subscriptionAuthFailure(
  error: Error,
  copy: (typeof SUBSCRIPTION_AUTH_COPY)[keyof typeof SUBSCRIPTION_AUTH_COPY],
): Error {
  if (!(error instanceof SubscriptionOAuthError)) return error;
  const turnOff = `turn off "${copy.subscriptionLabel}".`;
  const action = error.needsReauth
    ? `${copy.signInLabel} again, or ${turnOff}`
    : `Try again in a moment, or ${turnOff}`;
  return new AgentError(
    `${copy.subscriptionLabel} unavailable: ${error.message} ${action}`,
    { cause: error },
  );
}

/** How one OAuth subscription route reads its signed-in session. */
interface SubscriptionRouteRow {
  /** The API key the subscription stands in for. */
  readonly provider: ApiKeyProviderId;
  /**
   * The session read, refreshing an expired session; `refreshRejected`
   * below is the one forced refresh. Its failure passes
   * through `authFailure`, so a refresh that fails reaches the user as the
   * "sign in again, or turn off the preference" instruction.
   */
  readonly readSession: (
    secrets: PlatformSecrets,
  ) => Effect.Effect<SubscriptionSession, Error, HttpClient.HttpClient>;
  /** Refresh the session after the provider rejected its access token. */
  readonly refreshRejected: (
    secrets: PlatformSecrets,
  ) => Effect.Effect<void, Error, HttpClient.HttpClient>;
  readonly authFailure: (error: Error) => Error;
}

/**
 * The subscription routes, keyed by the route kind `decideModelRoute`
 * decided. Eligibility, the preference and the sign-in are the decision's;
 * a row only reads the session.
 *
 * Each binding calls through rather than capturing the imported value: the
 * table is built at module load, and a suite that partially mocks
 * `@texra-ai/llm/node` must still load this one.
 */
const SUBSCRIPTION_ROUTES: {
  readonly [K in SubscriptionSession['route']]: SubscriptionRouteRow;
} = {
  'chatgpt-subscription': {
    provider: 'openai',
    readSession: (secrets) =>
      Effect.gen(function* () {
        const session = yield* codexCoordinator(secrets).getFreshSession();
        return {
          route: 'chatgpt-subscription',
          accessToken: session.accessToken,
          accountId: session.accountId ?? null,
          plan: session.planType,
          endpoint: CODEX_BACKEND_BASE_URL,
          usageRoute: 'chatgpt-subscription',
        } as const;
      }),
    refreshRejected: (secrets) => codexCoordinator(secrets).refreshRejected(),
    authFailure: (error) =>
      subscriptionAuthFailure(error, SUBSCRIPTION_AUTH_COPY.chatgpt),
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
    refreshRejected: (secrets) => xaiCoordinator(secrets).refreshRejected(),
    authFailure: (error) =>
      subscriptionAuthFailure(error, SUBSCRIPTION_AUTH_COPY.grok),
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
  route: Extract<ModelRoute, { kind: SubscriptionSession['route'] }>,
  secrets: PlatformSecrets,
): Effect.fn.Return<SubscriptionRouteCredential, Error, HttpClient.HttpClient> {
  const row = SUBSCRIPTION_ROUTES[route.kind];
  const session = yield* row
    .readSession(secrets)
    .pipe(Effect.mapError(row.authFailure));
  return { ...session, provider: row.provider };
});

/**
 * Refresh a subscription route's session after the provider answered 401
 * to a token its stored expiry still calls fresh. A refresh that fails
 * surfaces as the route's "sign in again" instruction.
 */
export function refreshRejectedSubscription(
  route: SubscriptionSession['route'],
  secrets: PlatformSecrets,
): Effect.Effect<void, Error, HttpClient.HttpClient> {
  const row = SUBSCRIPTION_ROUTES[route];
  return row.refreshRejected(secrets).pipe(Effect.mapError(row.authFailure));
}

/**
 * Resolve the key and endpoint of an API-key route: the provider key the
 * decision named, or the OpenRouter key. The one producer of the
 * missing-credential fact the run lifecycle classifies for the loop, so the
 * failure carries the typed marker rather than a message pattern. `secrets`
 * is the process secret store the caller already holds; the endpoint is the
 * one the route's facts name for the provider.
 */
export const resolveRouteCredential = Effect.fn('resolveRouteCredential')(
  function* (
    facts: Pick<RouteFacts, 'endpoints'>,
    config: ModelConfig,
    route: Extract<
      ModelRoute,
      { kind: 'openrouter' | 'api-key' | 'no-api-key' }
    >,
    secrets: PlatformSecrets,
  ) {
    if (route.kind === 'no-api-key') {
      return yield* Effect.fail(
        new Error(`Model "${config.label}" has no direct API-key provider.`),
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
    const endpoint = resolveRouteEndpoint(config, route, facts);
    if (endpoint === undefined) {
      return yield* Effect.die(
        new Error(
          `No HTTP endpoint is configured for provider ${config.provider}.`,
        ),
      );
    }
    return {
      apiKey,
      endpoint,
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
  | Exclude<
      ModelRoute<CopilotModelRoute>,
      { kind: 'openrouter-unsupported' | 'copilot' }
    >
  | { readonly kind: 'copilot'; readonly route: CopilotModelRoute };

/**
 * The route `config` binds under, decided once over this workspace's facts,
 * and those facts (the binding reads the route's config and endpoint off
 * them).
 * A resumed conversation's backend constrains the facts it answers for: its
 * OpenRouter, Copilot and validation choice are the backend's, and a
 * subscription serves it only from its own provider, so turning a
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
    readonly backend?: ModelBackend;
    readonly ownApiKeyFallback?: boolean;
    readonly declinedRoutes?: readonly DeclinableUsageRoute[];
    /** The provider reasoning mode the request asks for (OpenAI `pro`). */
    readonly mode?: ReasoningMode;
  } = {},
): Effect.fn.Return<
  { readonly route: BindableRoute; readonly facts: HostRouteFacts },
  Error,
  LanguageModel
> {
  const host = yield* readRouteFacts(stores, options.declinedRoutes);
  const backend = options.backend;
  const prefersCopilot =
    backend === undefined
      ? !options.ownApiKeyFallback &&
        (yield* prefersCopilotRoute(config.ref, stores.globalState))
      : backend === 'copilot';
  // A provider mode never takes the Copilot preference (`decideModelRoute`),
  // so the editor is not asked for a route it would not use.
  const copilotRoute =
    (prefersCopilot && options.mode === undefined) ||
    config.provider === ModelProvider.COPILOT
      ? (yield* discoverCopilotRoutes()).get(config.ref)
      : undefined;
  const route = decideModelRoute(
    config,
    backend === undefined
      ? {
          ...host,
          validation: yield* shouldUseInternalValidationModel(),
          prefersCopilot,
          copilotRoute,
          mode: options.mode,
        }
      : {
          ...host,
          validation: backend === 'validation',
          prefersCopilot,
          copilotRoute,
          useOpenRouter: backend === 'openRouter',
          chatgptSubscription: host.chatgptSubscription && backend === 'openai',
          xaiSubscription: host.xaiSubscription && backend === 'xai',
          mode: options.mode,
        },
  );
  if (route.kind === 'openrouter-unsupported') {
    return yield* Effect.fail(
      new Error(
        `${config.label} in ${options.mode} mode is not served by OpenRouter. Disable OpenRouter and use the provider API directly.`,
      ),
    );
  }
  if (route.kind !== 'copilot') return { route, facts: host };
  // A fresh run needs the editor to allow the route; a resumed conversation
  // keeps its backend and binds whatever route the editor offers.
  const unavailableReason =
    backend === undefined
      ? copilotRouteUnavailableReason(config.ref, route.route)
      : undefined;
  if (unavailableReason) {
    return yield* Effect.fail(new AgentError(unavailableReason));
  }
  if (route.route === undefined) {
    return yield* Effect.fail(
      new Error(
        `No editor offers ${config.label} through Copilot now: Copilot models run through a VS Code window of this project with GitHub Copilot, and none is open or none offers this model. Open the project in VS Code, or turn off Copilot for this model.`,
      ),
    );
  }
  return { route: { kind: 'copilot', route: route.route }, facts: host };
});

/**
 * The config a binding sends on the wire under the user's "prefer short model
 * names" setting: the unpinned `shortName` in place of the date-pinned
 * `id`, for gateways that accept only the unpinned identifier. Applied
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
    !short ||
    short === config.id
  ) {
    return config;
  }
  yield* Effect.logDebug(
    `Using short model name for ${config.ref}: ${config.id} → ${short}`,
  ).pipe(withLogChannel(CHANNEL));
  return { ...config, id: short };
});

/**
 * The backend `route` serves `config` from: the model's own provider on a
 * direct route (any credential, subscription included), else the proxy that
 * serves it.
 */
export function routeBackend(
  config: ModelConfig,
  route: BindableRoute,
): Effect.Effect<ModelBackend | undefined> {
  switch (route.kind) {
    case 'validation':
      return Effect.succeed('validation');
    case 'copilot':
      return Effect.succeed('copilot');
    case 'openrouter':
      return Effect.succeed('openRouter');
    default: {
      // A provider string from outside the backends: a stale registry entry
      // or persisted config. The caller names the failure.
      const backend = ModelBackendSchema.safeParse(config.provider);
      if (backend.success) return Effect.succeed(backend.data);
      return Effect.logWarning(
        `No model backend is registered for provider ${config.provider}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(undefined));
    }
  }
}
