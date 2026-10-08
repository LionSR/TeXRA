/**
 * The credential one decided route bills: a provider or OpenRouter key, or
 * a signed-in subscription session (ChatGPT, Grok) standing in for the
 * provider's key. The secret reaches the binding's transport and never a
 * row. Every failure is a {@link RouteUnavailable} the user can act on.
 */
import { Effect } from 'effect';

import {
  exposeApiKey,
  getApiKey,
  resolveRouteEndpoint,
  type ApiKeyProviderId,
  type HostRouteFacts,
  type ModelRoute,
} from '@texra-ai/llm';
import {
  CODEX_BACKEND_BASE_URL,
  codexCoordinator,
  SubscriptionOAuthError,
  xaiCoordinator,
} from '@texra-ai/llm/node';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { readModelSettings } from '@model/modelSettings';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { PlatformSecrets } from '@platform/secrets';
import { SUBSCRIPTION_AUTH_COPY } from '@shared/model/accountAuth';
import type { UsageRoute } from '@shared/schemas';
import type { HttpClient } from 'effect/http';

import type { ModelConfig } from 'llm-zoo';

/**
 * The Grok subscription's OAuth token is accepted by xAI's own API surface
 * only; it is never sent to a dashboard custom endpoint or OpenRouter.
 */
const XAI_SUBSCRIPTION_ENDPOINT = 'https://api.x.ai/v1';

/** The routes that bill a credential. */
type CredentialRoute = Extract<
  ModelRoute,
  {
    kind:
      | 'api-key'
      | 'openrouter'
      | 'no-api-key'
      | 'chatgpt-subscription'
      | 'xai-subscription';
  }
>;

/** The credential and endpoint of one route, resolved together. */
export type RouteCredential = {
  readonly provider: ApiKeyProviderId;
  readonly endpoint: string;
  /** The secret the transport sends as its bearer. */
  readonly bearer: string;
  readonly usageRoute: UsageRoute;
} & (
  | { readonly route: 'api-key' | 'openrouter' | 'xai-subscription' }
  | {
      readonly route: 'chatgpt-subscription';
      readonly accountId: string | null;
      /** The ChatGPT plan the session's token names; display-only. */
      readonly plan: string | undefined;
    }
);

/**
 * A subscription session failure as the user's instruction: "sign in again,
 * or turn off the preference", not a raw auth error.
 */
function subscriptionUnavailable(
  route: 'chatgpt-subscription' | 'xai-subscription',
  error: Error,
): RouteUnavailable {
  const copy =
    SUBSCRIPTION_AUTH_COPY[
      route === 'chatgpt-subscription' ? 'chatgpt' : 'grok'
    ];
  const turnOff = `turn off "${copy.subscriptionLabel}".`;
  const action =
    error instanceof SubscriptionOAuthError && error.needsReauth
      ? `${copy.signInLabel} again, or ${turnOff}`
      : `Try again in a moment, or ${turnOff}`;
  return new RouteUnavailable({
    reason: 'unavailable',
    message: `${copy.subscriptionLabel} unavailable: ${error.message} ${action}`,
    cause: error,
  });
}

/**
 * The OAuth session a subscription route bills. The decision already found
 * the preference on, the model eligible and a session signed in, so this only
 * reads the session, refreshing an expired one. `renew` first refreshes a
 * token the provider rejected although its stored expiry still calls it
 * fresh (revoked, or expired server-side).
 */
const subscriptionCredential = (
  route: 'chatgpt-subscription' | 'xai-subscription',
  secrets: PlatformSecrets,
  renew: boolean,
): Effect.Effect<RouteCredential, RouteUnavailable, HttpClient.HttpClient> => {
  const session: Effect.Effect<RouteCredential, Error, HttpClient.HttpClient> =
    route === 'chatgpt-subscription'
      ? Effect.map(codexCoordinator(secrets).getFreshSession(), (fresh) => ({
          route,
          provider: 'openai',
          bearer: fresh.accessToken,
          accountId: fresh.accountId ?? null,
          plan: fresh.planType,
          endpoint: CODEX_BACKEND_BASE_URL,
          usageRoute: route,
        }))
      : Effect.map(xaiCoordinator(secrets).getFreshAccessToken(), (token) => ({
          route,
          provider: 'xai',
          bearer: token,
          endpoint: XAI_SUBSCRIPTION_ENDPOINT,
          usageRoute: route,
        }));
  const refresh =
    route === 'chatgpt-subscription'
      ? codexCoordinator(secrets).refreshRejected()
      : xaiCoordinator(secrets).refreshRejected();
  return (renew ? Effect.andThen(refresh, session) : session).pipe(
    Effect.mapError((error) => subscriptionUnavailable(route, error)),
  );
};

/**
 * The key and endpoint of an API-key route: the provider key the decision
 * named, or the OpenRouter key, at the endpoint the facts name for it. The
 * one producer of the missing-credential failure; an unreadable key store
 * fails as itself, not as a missing key.
 */
const apiKeyCredential = Effect.fn('credentials.apiKey')(function* (
  route: Extract<CredentialRoute, { kind: 'api-key' | 'openrouter' }>,
  config: ModelConfig,
  facts: Pick<HostRouteFacts, 'endpoints'>,
  secrets: PlatformSecrets,
): Effect.fn.Return<RouteCredential, RouteUnavailable> {
  const provider = route.kind === 'openrouter' ? 'openRouter' : route.provider;
  const bearer = yield* getApiKey(secrets, provider).pipe(
    Effect.map(exposeApiKey),
    Effect.catchTags({
      ApiKeyMissing: (cause) =>
        Effect.fail(
          new RouteUnavailable({
            reason: 'missing-api-key',
            message:
              route.kind === 'openrouter'
                ? 'Missing OpenRouter API key. Set an OpenRouter API key in settings.'
                : `Missing API key for ${provider}. Set a provider API key in settings.`,
            cause,
          }),
        ),
      SecretsFailed: (cause) =>
        Effect.fail(
          new RouteUnavailable({
            reason: 'unavailable',
            message: `Could not read the ${provider} API key: ${cause.message}`,
            cause,
          }),
        ),
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
    route: route.kind,
    provider,
    bearer,
    endpoint,
    usageRoute: route.kind === 'openrouter' ? 'api-key' : route.usageRoute,
  };
});

/** The credential `route` bills for `config`. */
export function routeCredential(
  route: CredentialRoute,
  config: ModelConfig,
  facts: Pick<HostRouteFacts, 'endpoints'>,
  secrets: PlatformSecrets,
  renew: boolean,
): Effect.Effect<RouteCredential, RouteUnavailable, HttpClient.HttpClient> {
  switch (route.kind) {
    case 'chatgpt-subscription':
    case 'xai-subscription':
      return subscriptionCredential(route.kind, secrets, renew);
    case 'no-api-key':
      return Effect.fail(
        new RouteUnavailable({
          reason: 'unavailable',
          message: `Model "${config.label}" has no direct API-key provider.`,
        }),
      );
    default:
      return apiKeyCredential(route, config, facts, secrets);
  }
}

/**
 * The user's own `provider` key and the endpoint they set for it, for a
 * request llm does not model (audio transcription): the route a model of
 * `config` takes with every preference off.
 */
export const ownKeyCredential = Effect.fn('ownKeyCredential')(function* (
  stores: ModelOptionStores,
  config: ModelConfig,
  provider: ApiKeyProviderId,
): Effect.fn.Return<RouteCredential, RouteUnavailable> {
  const settings = yield* readModelSettings(stores).pipe(
    Effect.mapError(
      (cause) =>
        new RouteUnavailable({
          reason: 'unavailable',
          message: cause.message,
          cause,
        }),
    ),
  );
  return yield* apiKeyCredential(
    { kind: 'api-key', provider, usageRoute: 'api-key' },
    config,
    settings.route,
    stores.secrets,
  );
});
