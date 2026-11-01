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
  PLAN_ROUTES,
  resolveRouteEndpoint,
  type RouteFacts,
} from '@texra-ai/llm';
import {
  SubscriptionOAuthError,
  subscriptionCredential,
} from '@texra-ai/llm/node';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { readProviderEndpoint } from '@model/modelSettings';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settings';
import { SUBSCRIPTION_AUTH_NAMES } from '@shared/model/subscriptionAuth';
import type { HttpClient } from 'effect/http';

/** A route that bills a signed-in subscription session. */
type SessionRoute = Exclude<CredentialRoute['kind'], 'api-key'>;

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
  route: SessionRoute,
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
 * The key and endpoint of an API-key route: the provider key the decision
 * named, at the endpoint the facts name for it. The
 * one producer of the missing-credential failure; an unreadable key store
 * fails as itself, not as a missing key.
 */
const apiKeyCredential = Effect.fn('credentials.apiKey')(function* (
  route: Extract<CredentialRoute, { kind: 'api-key' }>,
  config: ModelConfig,
  facts: Pick<RouteFacts, 'endpoints'>,
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

/**
 * The credential `route` bills for `config`. A subscription route sends its
 * signed-in session at the subscription's own surface, which
 * `resolveRouteEndpoint` names ahead of any per-model or dashboard endpoint,
 * since the token is accepted nowhere else. The decision already found the
 * preference on, the model eligible and a session signed in, so this only
 * reads the session.
 */
export const routeCredential = Effect.fn('credentials.route')(function* (
  route: CredentialRoute,
  config: ModelConfig,
  facts: Pick<RouteFacts, 'endpoints'>,
  rejected: string | undefined,
): Effect.fn.Return<
  RouteCredential,
  RouteUnavailable,
  HttpClient.HttpClient | Secrets
> {
  if (route.kind === 'api-key')
    return yield* apiKeyCredential(route, config, facts);
  const { kind } = route;
  const endpoint = yield* routeEndpoint(config, route, facts);
  const session = yield* subscriptionCredential(
    kind,
    yield* Secrets,
    rejected,
  ).pipe(Effect.mapError((error) => subscriptionUnavailable(kind, error)));
  return {
    route: kind,
    provider: PLAN_ROUTES[kind].provider,
    endpoint,
    ...session,
  };
});

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
