/**
 * The credential one decided route bills: a provider key, or a signed-in
 * subscription session (ChatGPT, Grok) standing in for the provider's key.
 * The secret reaches the binding's transport and never a row. Every failure
 * is a {@link RouteUnavailable} the user can act on.
 */
import { Effect } from 'effect';

import {
  apiKey,
  type ApiKeyProviderId,
  type CredentialRoute,
  decideModelRoute,
  exposeApiKey,
  type ModelConfig,
  ModelError,
  OWN_KEY_ROUTE_FACTS,
  PLAN_ROUTES,
} from '@texra-ai/llm';
import { type SessionToken, SubscriptionAccounts } from '@texra-ai/llm/node';
import { HttpClient } from 'effect/http';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { readProviderEndpoint } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';

/** A route that bills a signed-in subscription session. */
type SessionRoute = Exclude<CredentialRoute['kind'], 'api-key'>;

/**
 * The credential of one route. `bearer` is what the transport sends: a key,
 * or a session's token, which llm reads per request and renews once when
 * the provider rejects it.
 */
export type RouteCredential = {
  readonly provider: ApiKeyProviderId;
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

/** An API-key route's credential: its key. */
type KeyCredential = Extract<RouteCredential, { readonly route: 'api-key' }>;

/**
 * The OAuth session a subscription route bills. The decision already found the preference on, the model eligible
 * and a session signed in; this reads the session once, for its plan and so
 * a signed-out session fails here, and hands the transport the session's
 * token, which llm reads before each request and renews once when the
 * provider rejects it. A session failure inside a request is llm's
 * `authentication` failure, its cause this route's {@link RouteUnavailable}.
 */
const subscriptionCredential = Effect.fn('credentials.subscription')(function* (
  route: SessionRoute,
): Effect.fn.Return<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | SubscriptionAccounts
> {
  const accounts = yield* SubscriptionAccounts;
  const account = accounts[route];
  const http = yield* HttpClient.HttpClient;
  const { provider } = PLAN_ROUTES[route];
  const unavailable = (error: Error) =>
    RouteUnavailable.ofSession(route, error);
  /** A read of the session inside a request: its failures llm's
   *  `authentication`, caused by this route's own. */
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
  const bearer: SessionToken = {
    current: inRequest(
      Effect.map(account.getFreshSession(), (fresh) => fresh.accessToken),
    ),
    rejected: (token) => inRequest(account.refreshRejected(token)),
  };
  if (route === 'chatgpt-subscription') {
    const fresh = yield* Effect.mapError(
      accounts[route].getFreshSession(),
      unavailable,
    );
    return { route, provider, bearer, plan: fresh.planType };
  }
  yield* Effect.mapError(account.getFreshSession(), unavailable);
  return { route, provider, bearer };
});

/**
 * The key of an API-key route: the provider key the decision named. The one
 * producer of the missing-credential failure; an unreadable key store fails
 * as itself, not as a missing key.
 */
const apiKeyCredential = Effect.fn('credentials.apiKey')(function* (
  route: Extract<CredentialRoute, { kind: 'api-key' }>,
): Effect.fn.Return<KeyCredential, RouteUnavailable, Secrets> {
  const { provider } = route;
  const { value: key } = yield* apiKey(yield* Secrets, provider).pipe(
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
  return { route: route.kind, provider, bearer: exposeApiKey(key) };
});

/** The credential `route` bills. */
export function routeCredential(
  route: CredentialRoute,
): Effect.Effect<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets | SubscriptionAccounts
> {
  return route.kind === 'api-key'
    ? apiKeyCredential(route)
    : subscriptionCredential(route.kind);
}

/**
 * The user's own key for `config` and the endpoint they set for its
 * provider, for a request llm does not model (audio transcription): the
 * route `config` takes with every preference off.
 */
export const ownKeyCredential = Effect.fn('ownKeyCredential')(function* (
  stores: SettingsStores,
  config: ModelConfig,
): Effect.fn.Return<
  KeyCredential & { readonly endpoint: string },
  RouteUnavailable,
  Secrets
> {
  // The key and its endpoint only: no other model setting can refuse it.
  const endpoints = yield* readProviderEndpoint(stores, config.provider).pipe(
    Effect.mapError(RouteUnavailable.of),
  );
  const route = decideModelRoute(config, { ...OWN_KEY_ROUTE_FACTS, endpoints });
  if (route.kind !== 'api-key') {
    return yield* new RouteUnavailable({
      message: `Model "${config.label}" has no direct API-key provider.`,
    });
  }
  const credential = yield* apiKeyCredential(route);
  return { ...credential, endpoint: route.endpoint };
});
