/**
 * The credential one decided route bills: a provider key, or a signed-in
 * subscription session (ChatGPT, Grok) standing in for the provider's key.
 * The secret reaches the binding's transport and never a row. Every failure
 * is a {@link RouteUnavailable} the user can act on.
 */
import { Effect } from 'effect';

import {
  type ApiKeyProviderId,
  exposeApiKey,
  type HostRouteFacts,
  lookupApiKey,
  type ModelConfig,
  type ModelRoute,
  resolveRouteEndpoint,
} from '@texra-ai/llm';
import {
  codexCoordinator,
  SubscriptionOAuthError,
  xaiCoordinator,
} from '@texra-ai/llm/node';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { readProviderEndpoint } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';
import { SUBSCRIPTION_AUTH_NAMES } from '@shared/model/subscriptionAuth';
import type { UsageRoute } from '@shared/schemas';
import type { HttpClient } from 'effect/http';

/** The routes that bill a credential. */
type CredentialRoute = Extract<
  ModelRoute,
  {
    kind:
      'api-key' | 'no-api-key' | 'chatgpt-subscription' | 'xai-subscription';
  }
>;

/**
 * What a route bills: the plan a direct key pays through, a subscription, or
 * the user's own key (the validation model). The one
 * owner of the fact: the binding sends it as the wire's billing and pricing
 * stamps it on each turn's usage.
 */
export function usageRouteOf(route: ModelRoute): UsageRoute {
  switch (route.kind) {
    case 'api-key':
      return route.usageRoute;
    case 'chatgpt-subscription':
    case 'xai-subscription':
      return route.kind;
    case 'validation':
    case 'no-api-key':
    case 'unserved': // never bound: the route decision refuses it
      return 'api-key';
    default:
      return route satisfies never;
  }
}

/** The credential and endpoint of one route, resolved together. */
export type RouteCredential = {
  readonly provider: ApiKeyProviderId;
  readonly endpoint: string;
  /** The secret the transport sends as its bearer. */
  readonly bearer: string;
} & (
  | { readonly route: 'api-key' | 'xai-subscription' }
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
    SUBSCRIPTION_AUTH_NAMES[
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
 * The endpoint `route` sends `config`'s requests to. A provider the catalog
 * states no endpoint for is a defect, not a route the user can fix.
 */
const routeEndpoint = (
  config: ModelConfig,
  route: Exclude<CredentialRoute, { kind: 'no-api-key' }>,
  facts: Pick<HostRouteFacts, 'endpoints'>,
): Effect.Effect<string> => {
  const endpoint = resolveRouteEndpoint(config, route, facts);
  return endpoint === undefined
    ? Effect.die(
        new Error(
          `No HTTP endpoint is configured for provider ${config.provider}.`,
        ),
      )
    : Effect.succeed(endpoint);
};

/**
 * The OAuth session a subscription route bills, at `endpoint`: the
 * subscription's own surface, which `resolveRouteEndpoint` names ahead of
 * any per-model or dashboard endpoint, since the token is accepted nowhere
 * else. The decision already found the preference on, the model eligible
 * and a session signed in, so this only reads the session, refreshing an
 * expired one. `rejected` is a token the provider rejected although its
 * stored expiry still calls it fresh (revoked, or expired server-side): it
 * is refreshed first, while stored.
 */
const subscriptionCredential = Effect.fn('credentials.subscription')(function* (
  route: 'chatgpt-subscription' | 'xai-subscription',
  endpoint: string,
  rejected: string | undefined,
): Effect.fn.Return<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets
> {
  const secrets = yield* Secrets;
  const session: Effect.Effect<RouteCredential, Error, HttpClient.HttpClient> =
    route === 'chatgpt-subscription'
      ? Effect.map(codexCoordinator(secrets).getFreshSession(), (fresh) => ({
          route,
          provider: 'openai',
          bearer: fresh.accessToken,
          accountId: fresh.accountId ?? null,
          plan: fresh.planType,
          endpoint,
        }))
      : Effect.map(xaiCoordinator(secrets).getFreshSession(), (fresh) => ({
          route,
          provider: 'xai',
          bearer: fresh.accessToken,
          endpoint,
        }));
  const refresh = (token: string) =>
    route === 'chatgpt-subscription'
      ? codexCoordinator(secrets).refreshRejected(token)
      : xaiCoordinator(secrets).refreshRejected(token);
  return yield* (
    rejected === undefined
      ? session
      : Effect.andThen(refresh(rejected), session)
  ).pipe(Effect.mapError((error) => subscriptionUnavailable(route, error)));
});

/**
 * The key and endpoint of an API-key route: the provider key the decision
 * named, at the endpoint the facts name for it. The
 * one producer of the missing-credential failure; an unreadable key store
 * fails as itself, not as a missing key.
 */
const apiKeyCredential = Effect.fn('credentials.apiKey')(function* (
  route: Extract<CredentialRoute, { kind: 'api-key' }>,
  config: ModelConfig,
  facts: Pick<HostRouteFacts, 'endpoints'>,
): Effect.fn.Return<RouteCredential, RouteUnavailable, Secrets> {
  const { provider } = route;
  const key = yield* lookupApiKey(yield* Secrets, provider).pipe(
    Effect.mapError(
      (cause) =>
        new RouteUnavailable({
          reason: 'unavailable',
          message: `Could not read the ${provider} API key: ${cause.message}`,
          cause,
        }),
    ),
  );
  if (key === undefined) {
    return yield* new RouteUnavailable({
      reason: 'missing-api-key',
      message: `Missing API key for ${provider}. Set a provider API key in settings.`,
    });
  }
  const bearer = exposeApiKey(key);
  const endpoint = yield* routeEndpoint(config, route, facts);
  return {
    route: route.kind,
    provider,
    bearer,
    endpoint,
  };
});

/** The credential `route` bills for `config`. */
export function routeCredential(
  route: CredentialRoute,
  config: ModelConfig,
  facts: Pick<HostRouteFacts, 'endpoints'>,
  rejected: string | undefined,
): Effect.Effect<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets
> {
  switch (route.kind) {
    case 'chatgpt-subscription':
    case 'xai-subscription':
      return Effect.flatMap(routeEndpoint(config, route, facts), (endpoint) =>
        subscriptionCredential(route.kind, endpoint, rejected),
      );
    case 'no-api-key':
      return Effect.fail(
        new RouteUnavailable({
          reason: 'unavailable',
          message: `Model "${config.label}" has no direct API-key provider.`,
        }),
      );
    default:
      return apiKeyCredential(route, config, facts);
  }
}

/**
 * The user's own `provider` key and the endpoint they set for it, for a
 * request llm does not model (audio transcription): the route a model of
 * `config` takes with every preference off.
 */
export const ownKeyCredential = Effect.fn('ownKeyCredential')(function* (
  stores: SettingsStores,
  config: ModelConfig,
  provider: ApiKeyProviderId,
): Effect.fn.Return<RouteCredential, RouteUnavailable, Secrets> {
  // The key and its endpoint only: no other model setting can refuse it.
  const endpoints = yield* readProviderEndpoint(stores, provider).pipe(
    Effect.mapError(RouteUnavailable.of),
  );
  return yield* apiKeyCredential(
    { kind: 'api-key', provider, usageRoute: 'api-key' },
    config,
    { endpoints },
  );
});
