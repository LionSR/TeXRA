/**
 * The credential one decided route bills: a provider key, or a signed-in
 * subscription session (ChatGPT, Grok) standing in for the provider's key.
 * The secret reaches the binding's transport and never a row. Every failure
 * is a {@link RouteUnavailable} the user can act on.
 */
import { Effect } from 'effect';

import {
  type ApiKeyProviderId,
  type CredentialRoute,
  exposeApiKey,
  lookupApiKey,
  type ModelConfig,
  ModelError,
  PLAN_ROUTES,
  resolveRouteEndpoint,
  type RouteFacts,
} from '@texra-ai/llm';
import {
  chatgptCoordinator,
  type SessionToken,
  SubscriptionOAuthError,
  xaiCoordinator,
} from '@texra-ai/llm/node';
import { HttpClient } from 'effect/http';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { readProviderEndpoint } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';

/** A route that bills a signed-in subscription session. */
type SessionRoute = Exclude<CredentialRoute['kind'], 'api-key'>;

/**
 * The credential and endpoint of one route, resolved together. `bearer` is
 * what the transport sends: a key, or a session's token, which llm reads
 * per request and renews once when the provider rejects it.
 */
export type RouteCredential = {
  readonly provider: ApiKeyProviderId;
  readonly endpoint: string;
} & (
  | { readonly route: 'api-key'; readonly bearer: string }
  | { readonly route: 'xai-subscription'; readonly bearer: SessionToken }
  | {
      readonly route: 'chatgpt-subscription';
      readonly bearer: SessionToken;
      /** The ChatGPT plan the session's token names; display-only. */
      readonly plan: string | undefined;
    }
);

/** An API-key route's credential: its key and endpoint. */
type KeyCredential = Extract<RouteCredential, { readonly route: 'api-key' }>;

/**
 * A subscription session failure as its facts: the route that could not
 * bill, the session's own failure, and whether only a fresh sign-in helps.
 * `providerErrorOf` words them; a host's copy may word them its own way.
 */
const subscriptionUnavailable = (
  route: SessionRoute,
  error: Error,
): RouteUnavailable =>
  new RouteUnavailable({
    message: error.message,
    session: {
      route,
      needsReauth: error instanceof SubscriptionOAuthError && error.needsReauth,
    },
    cause: error,
  });

/**
 * The endpoint `route` sends `config`'s requests to. A provider the catalog
 * states no endpoint for is a defect, not a route the user can fix.
 */
const routeEndpoint = (
  config: ModelConfig,
  route: CredentialRoute,
  facts: Pick<RouteFacts, 'endpoints'>,
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
 * and a session signed in; this reads the session once, for its plan and so
 * a signed-out session fails here, and hands the transport the session's
 * token, which llm reads before each request and renews once when the
 * provider rejects it. A session failure inside a request is llm's
 * `authentication` failure, its cause this route's {@link RouteUnavailable}.
 */
const subscriptionCredential = Effect.fn('credentials.subscription')(function* (
  route: SessionRoute,
  endpoint: string,
): Effect.fn.Return<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets
> {
  const secrets = yield* Secrets;
  const http = yield* HttpClient.HttpClient;
  const { provider } = PLAN_ROUTES[route];
  const unavailable = (error: Error) => subscriptionUnavailable(route, error);
  /** A session's token for the transport, its failures llm's
   *  `authentication`, caused by this route's own. */
  const tokenOf = (session: {
    readonly getFreshSession: () => Effect.Effect<
      { readonly accessToken: string },
      Error,
      HttpClient.HttpClient
    >;
    readonly refreshRejected: (
      token: string,
    ) => Effect.Effect<void, Error, HttpClient.HttpClient>;
  }): SessionToken => {
    const inRequest = <A>(
      effect: Effect.Effect<A, Error, HttpClient.HttpClient>,
    ): Effect.Effect<A, ModelError> =>
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => {
          const cause = unavailable(error);
          return new ModelError({
            kind: 'authentication',
            message: cause.message,
            cause,
          });
        }),
      );
    return {
      current: inRequest(
        Effect.map(session.getFreshSession(), (fresh) => fresh.accessToken),
      ),
      rejected: (token) => inRequest(session.refreshRejected(token)),
    };
  };
  if (route === 'chatgpt-subscription') {
    const coordinator = chatgptCoordinator(secrets);
    const fresh = yield* Effect.mapError(
      coordinator.getFreshSession(),
      unavailable,
    );
    return {
      route,
      provider,
      bearer: tokenOf(coordinator),
      plan: fresh.planType,
      endpoint,
    };
  }
  const coordinator = xaiCoordinator(secrets);
  yield* Effect.mapError(coordinator.getFreshSession(), unavailable);
  return { route, provider, bearer: tokenOf(coordinator), endpoint };
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
  facts: Pick<RouteFacts, 'endpoints'>,
): Effect.fn.Return<KeyCredential, RouteUnavailable, Secrets> {
  const { provider } = route;
  const key = yield* lookupApiKey(yield* Secrets, provider).pipe(
    Effect.mapError(
      (cause) =>
        new RouteUnavailable({
          message: `Could not read the ${provider} API key: ${cause.message}`,
          cause,
        }),
    ),
  );
  if (key === undefined) {
    return yield* new RouteUnavailable({
      missingApiKey: true,
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
  facts: Pick<RouteFacts, 'endpoints'>,
): Effect.Effect<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets
> {
  return route.kind === 'api-key'
    ? apiKeyCredential(route, config, facts)
    : Effect.flatMap(routeEndpoint(config, route, facts), (endpoint) =>
        subscriptionCredential(route.kind, endpoint),
      );
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
): Effect.fn.Return<KeyCredential, RouteUnavailable, Secrets> {
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
