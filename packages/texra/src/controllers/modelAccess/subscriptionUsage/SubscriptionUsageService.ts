import { Cache, Cause, Clock, Duration, Effect } from 'effect';
import { Secrets, Settings, withLogChannel } from '@texra-ai/harness/host';
import { HttpClientError } from 'effect/http';

import { codexCoordinator, SubscriptionOAuthError } from '@texra-ai/llm/node';
import { lookupApiKey } from '@texra-ai/llm';
import { toErrorMessage, GlobalStateKey } from '@texra-ai/harness/schemas';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSnapshots,
} from '@texra/shared/model/subscriptionUsage';
import { SUBSCRIPTION_USAGE_PROVIDERS } from '@texra/shared/model/subscriptionUsage';
import { CODING_PLAN_SUBSCRIPTIONS } from '@texra/shared/model/codingPlans';

import { fetchChatGptUsage } from './codexUsageAdapter';
import {
  fetchGlmCodingPlanUsage,
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
} from './glmCodingPlanUsageAdapter';
import { fetchKimiCodeUsage } from './kimiCodeUsageAdapter';
import type { SettingsStores } from '@texra-ai/harness/host';
import type { ParsedSubscriptionUsage } from './subscriptionUsageParsing';
import type { HttpClient } from 'effect/http';

const CHANNEL = 'SubscriptionUsage';

/** A coding plan's stored key, from the process `Secrets`. */
const lookupStoredKey = (provider: 'kimiCode' | 'glm') =>
  Effect.flatMap(Secrets, (secrets) => lookupApiKey(secrets, provider));

const CACHE_TTL = Duration.seconds(30);
/** The one deadline over a usage request and its body read. */
const REQUEST_TIMEOUT_MS = 15_000;

type CodingPlanUsageProvider =
  (typeof CODING_PLAN_SUBSCRIPTIONS)[number]['usageProvider'];

function mapCodingPlanSubscriptions(
  field: 'credentialName' | 'displayName',
): Record<CodingPlanUsageProvider, string> {
  return Object.fromEntries(
    CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.usageProvider, plan[field]]),
  ) as Record<CodingPlanUsageProvider, string>;
}

const PROVIDER_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT',
  ...mapCodingPlanSubscriptions('credentialName'),
};

const DEFAULT_PLAN_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT Coding Plan',
  ...mapCodingPlanSubscriptions('displayName'),
};

/** The setting slots this service reads; credentials come from the process
 *  `Secrets`. */
interface SubscriptionUsageServiceInit {
  readonly stores: SettingsStores;
}

/** One cache entry per provider and request variant (the GLM region). */
type UsageCacheKey = readonly [SubscriptionUsageProvider, boolean | undefined];

/** Why a usage snapshot carries no data (the `unavailable` variant's reason). */
type SubscriptionUsageUnavailableReason = Extract<
  SubscriptionUsageSnapshot,
  { state: 'unavailable' }
>['reason'];

interface SubscriptionUsageAdapter {
  /** Credential-derived request variant (today: the GLM region flag). */
  readonly resolveVariant?: () => Effect.Effect<boolean, Error>;
  readonly fetch: (
    variant: boolean | undefined,
  ) => Effect.Effect<
    ParsedSubscriptionUsage | null,
    Error,
    HttpClient.HttpClient | Secrets
  >;
}

/**
 * Read-only, host-neutral access to coding-plan usage. Every read is a
 * program: results are short-lived, coalesced per provider, and always
 * succeed with a snapshot rather than exposing provider transport failures to
 * extension or CLI consumers — the failure channel is `never`, so a caller
 * has no error arm to write.
 */
export class SubscriptionUsageService {
  private readonly stores: SettingsStores;
  private readonly adapters: Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  >;
  private cache:
    | Cache.Cache<
        UsageCacheKey,
        SubscriptionUsageSnapshot,
        never,
        HttpClient.HttpClient | Secrets
      >
    | undefined;

  constructor(init: SubscriptionUsageServiceInit) {
    this.stores = init.stores;
    this.adapters = this.createAdapters();
  }

  /**
   * The snapshot cache, made on the first read because the settings body
   * builds this service outside any program. Entries live for the TTL by the
   * reading fiber's `Clock`; concurrent reads of one key share one lookup, and
   * the lookup is interrupted once every waiting reader has left.
   */
  private readonly usageCache = Effect.suspend(() =>
    this.cache
      ? Effect.succeed(this.cache)
      : Effect.map(
          Cache.makeWith(
            ([provider, variant]: UsageCacheKey) =>
              this.fetchUsage(provider, variant),
            {
              capacity: 64,
              timeToLive: () => CACHE_TTL,
              requireServicesAt: 'lookup',
            },
          ),
          (made) => (this.cache ??= made),
        ),
  );

  /** Provider transports are adapters; caching and failure policy stay common. */
  private createAdapters(): Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  > {
    // Each adapter fetch is already a program over the `HttpClient` service,
    // so the client's own failure reaches the fold below unchanged.
    // `REQUEST_TIMEOUT_MS` is the one deadline over the request and body read.
    return Object.freeze({
      chatgpt: {
        // A 401 on a token its stored expiry still calls fresh refreshes
        // that token, while it is still the stored one; a refresh the server
        // refuses clears the session, so the account reads as signed out
        // instead of "ready to use".
        fetch: () => {
          const fetchOnce = Effect.flatMap(
            this.loadChatGptCredential(),
            (credential) =>
              credential
                ? fetchChatGptUsage(credential, REQUEST_TIMEOUT_MS)
                : Effect.succeed(null),
          );
          return Effect.flatMap(this.loadChatGptCredential(), (sent) =>
            sent === null
              ? Effect.succeed(null)
              : fetchChatGptUsage(sent, REQUEST_TIMEOUT_MS).pipe(
                  Effect.catchIf(
                    (error) =>
                      HttpClientError.isHttpClientError(error) &&
                      error.reason._tag === 'StatusCodeError' &&
                      error.reason.response.status === 401,
                    () =>
                      Effect.flatMap(Secrets, (secrets) =>
                        codexCoordinator(secrets).refreshRejected(
                          sent.accessToken,
                        ),
                      ).pipe(Effect.andThen(fetchOnce)),
                  ),
                ),
          );
        },
      },
      kimiCode: {
        fetch: () =>
          Effect.flatMap(lookupStoredKey('kimiCode'), (apiKey) =>
            apiKey
              ? fetchKimiCodeUsage(apiKey, REQUEST_TIMEOUT_MS)
              : Effect.succeed(null),
          ),
      },
      glmCodingPlan: {
        resolveVariant: () =>
          Settings.get<boolean>(this.stores, GlobalStateKey.GLM_USE_CHINA),
        fetch: (useChina) =>
          Effect.flatMap(lookupStoredKey('glm'), (apiKey) =>
            apiKey
              ? fetchGlmCodingPlanUsage(
                  apiKey,
                  REQUEST_TIMEOUT_MS,
                  (useChina ?? true)
                    ? GLM_CODING_PLAN_USAGE_URL
                    : GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
                )
              : Effect.succeed(null),
          ),
      },
    });
  }

  /**
   * The stored ChatGPT session's usage credential, or `null` when no session
   * is stored. Refreshing an expiring session is the coordinator's own job, so
   * a refresh that fails reaches {@link fetchUsage}'s classification as the
   * `SubscriptionOAuthError` it raised.
   */
  private readonly loadChatGptCredential = Effect.fn(
    'SubscriptionUsage.loadChatGptCredential',
  )(function* () {
    const coordinator = codexCoordinator(yield* Secrets);
    if ((yield* coordinator.loadSession()) === null) return null;
    const session = yield* coordinator.getFreshSession();
    return {
      accessToken: session.accessToken,
      ...(session.accountId ? { accountId: session.accountId } : {}),
    };
  });

  /**
   * Drop a provider's cached and in-flight entries after its credentials or
   * account change. A reader already waiting on an in-flight lookup still
   * receives its result, but that result is not cached.
   */
  invalidate(provider: SubscriptionUsageProvider): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const cache = yield* this.usageCache;
      for (const key of [...(yield* Cache.keys(cache))]) {
        if (key[0] === provider) yield* Cache.invalidate(cache, key);
      }
    });
  }

  getUsage(
    provider: SubscriptionUsageProvider,
    options: { readonly forceRefresh?: boolean } = {},
  ): Effect.Effect<
    SubscriptionUsageSnapshot,
    never,
    HttpClient.HttpClient | Secrets
  > {
    const adapter = this.adapters[provider];
    return Effect.matchCauseEffect(
      Effect.suspend(
        (): Effect.Effect<boolean | undefined, Error> =>
          adapter.resolveVariant?.() ?? Effect.succeed(undefined),
      ),
      {
        onFailure: (cause) =>
          Effect.gen({ self: this }, function* () {
            const error = Cause.squash(cause);
            yield* Effect.logWarning(
              `Subscription usage variant probe failed for ${provider}: ${toErrorMessage(error)}`,
            ).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel(CHANNEL),
            );
            return yield* this.unavailable(provider, 'request_failed');
          }),
        onSuccess: (variant) => this.coalesced(provider, variant, options),
      },
    );
  }

  /** One snapshot per subscription provider, for a settings-view refresh. */
  getAllUsage(
    options: { readonly forceRefresh?: boolean } = {},
  ): Effect.Effect<
    SubscriptionUsageSnapshots,
    never,
    HttpClient.HttpClient | Secrets
  > {
    // Each snapshot key is the provider id itself, so key and provider can
    // never drift apart the way a positional destructure would allow.
    return Effect.map(
      Effect.forEach(
        SUBSCRIPTION_USAGE_PROVIDERS,
        (provider) =>
          Effect.map(
            this.getUsage(provider, options),
            (snapshot) => [provider, snapshot] as const,
          ),
        { concurrency: 'unbounded' },
      ),
      (entries) => Object.fromEntries(entries) as SubscriptionUsageSnapshots,
    );
  }

  /** One lookup per key at a time, served from the cache while it is warm. */
  private coalesced(
    provider: SubscriptionUsageProvider,
    variant: boolean | undefined,
    options: { readonly forceRefresh?: boolean },
  ): Effect.Effect<
    SubscriptionUsageSnapshot,
    never,
    HttpClient.HttpClient | Secrets
  > {
    const key: UsageCacheKey = [provider, variant];
    return Effect.flatMap(this.usageCache, (cache) =>
      options.forceRefresh
        ? Effect.andThen(Cache.invalidate(cache, key), Cache.get(cache, key))
        : Cache.get(cache, key),
    );
  }

  private unavailable(
    provider: SubscriptionUsageProvider,
    reason: SubscriptionUsageUnavailableReason,
  ): Effect.Effect<SubscriptionUsageSnapshot> {
    return Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({
      state: 'unavailable',
      providerName: PROVIDER_NAMES[provider],
      planName: DEFAULT_PLAN_NAMES[provider],
      windows: [],
      fetchedAt,
      reason,
    }));
  }

  private available(
    provider: SubscriptionUsageProvider,
    parsed: ParsedSubscriptionUsage,
  ): Effect.Effect<SubscriptionUsageSnapshot> {
    return Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({
      state: 'available',
      providerName: PROVIDER_NAMES[provider],
      planName: parsed.planName ?? DEFAULT_PLAN_NAMES[provider],
      windows: [...parsed.windows],
      fetchedAt,
    }));
  }

  private fetchUsage(
    provider: SubscriptionUsageProvider,
    variant: boolean | undefined,
  ): Effect.Effect<
    SubscriptionUsageSnapshot,
    never,
    HttpClient.HttpClient | Secrets
  > {
    return Effect.suspend(() => this.adapters[provider].fetch(variant)).pipe(
      Effect.flatMap((parsed) => {
        if (parsed === null) {
          return this.unavailable(provider, 'missing_credentials');
        }
        if (parsed.windows.length === 0) {
          return this.unavailable(provider, 'malformed_response');
        }
        return this.available(provider, parsed);
      }),
      Effect.catchCause((cause) =>
        Effect.gen({ self: this }, function* () {
          // The reason a failed fetch maps to, most specific cause first. The
          // failure classes are disjoint, so at most one of these checks
          // holds. The reason alone cannot tell a routine refusal from an
          // unexpected fault, so the cause is named once here.
          const error = Cause.squash(cause);
          // An HttpClientError carries its request, headers included (the
          // ChatGPT account id unredacted), so only its reason is logged.
          const httpError = HttpClientError.isHttpClientError(error)
            ? error.reason
            : undefined;
          const status =
            httpError?._tag === 'StatusCodeError'
              ? httpError.response.status
              : undefined;
          yield* Effect.logWarning(
            `Subscription usage fetch failed for ${provider}: ${toErrorMessage(error)}`,
          ).pipe(
            Effect.annotateLogs({
              data: httpError ? { reason: httpError._tag, status } : error,
            }),
            withLogChannel(CHANNEL),
          );
          const invalidCredentials =
            (error instanceof SubscriptionOAuthError && error.needsReauth) ||
            status === 401 ||
            status === 403;
          if (invalidCredentials) {
            return yield* this.unavailable(provider, 'invalid_credentials');
          }
          if (
            httpError?._tag === 'DecodeError' &&
            httpError.cause instanceof SyntaxError
          ) {
            return yield* this.unavailable(provider, 'malformed_response');
          }
          return yield* this.unavailable(provider, 'request_failed');
        }),
      ),
    );
  }
}
