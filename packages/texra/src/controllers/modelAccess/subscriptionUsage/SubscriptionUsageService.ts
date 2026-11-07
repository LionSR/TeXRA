import {
  Cache,
  Cause,
  Clock,
  Duration,
  Effect,
  Record as EffectRecord,
} from 'effect';
import {
  Secrets,
  Settings,
  withLogChannel,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import { HttpClientError } from 'effect/http';

import { apiKey } from '@texra-ai/llm';
import { toErrorMessage, GLM_REGION_SETTING } from '@texra-ai/harness/schemas';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSnapshots,
} from '@texra/shared/model/subscriptionUsage';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';

import {
  fetchGlmCodingPlanUsage,
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
} from './glmCodingPlanUsageAdapter';
import { fetchKimiCodeUsage } from './kimiCodeUsageAdapter';
import type { ParsedSubscriptionUsage } from './subscriptionUsageParsing';
import type { HttpClient } from 'effect/http';

const CHANNEL = 'SubscriptionUsage';

/** A coding plan's stored key, from the process `Secrets`. */
const lookupStoredKey = (provider: 'kimiCode' | 'glm') =>
  Effect.flatMap(Secrets, (secrets) =>
    Effect.map(apiKey(secrets, provider), (key) => key.value),
  );

const CACHE_TTL = Duration.seconds(30);
/** The one deadline over a usage request and its body read. */
const REQUEST_TIMEOUT_MS = 15_000;

const [KIMI_CODE_PLAN, GLM_CODING_PLAN] = CODING_PLAN_SUBSCRIPTIONS;

/** Each subscription's catalog plan, by the provider that reports its usage. */
const PLAN_BY_PROVIDER = {
  [KIMI_CODE_PLAN.usageProvider]: KIMI_CODE_PLAN,
  [GLM_CODING_PLAN.usageProvider]: GLM_CODING_PLAN,
} satisfies Record<SubscriptionUsageProvider, CodingPlanSubscription>;

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
 * has no error case to write.
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
    // so the client's own failure reaches the handler below unchanged.
    // `REQUEST_TIMEOUT_MS` is the one deadline over the request and body read.
    return Object.freeze({
      kimiCode: {
        fetch: () =>
          Effect.flatMap(lookupStoredKey('kimiCode'), (apiKey) =>
            apiKey
              ? fetchKimiCodeUsage(apiKey, REQUEST_TIMEOUT_MS)
              : Effect.succeed(null),
          ),
      },
      glmCodingPlan: {
        resolveVariant: () => Settings.get(this.stores, GLM_REGION_SETTING),
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
   * Drop a provider's cached and in-flight entries after its credentials or
   * account change. A reader already waiting on an in-flight lookup still
   * receives its result, but that result is not cached.
   */
  readonly invalidate = Effect.fn('SubscriptionUsageService.invalidate')(
    { self: this },
    function* (provider: SubscriptionUsageProvider): Effect.fn.Return<void> {
      const cache = yield* this.usageCache;
      for (const key of [...(yield* Cache.keys(cache))]) {
        if (key[0] === provider) yield* Cache.invalidate(cache, key);
      }
    },
  );

  /** Drop every cached and in-flight entry, so the next reads fetch: the
   *  usage panel's refresh. */
  readonly invalidateAll = Effect.fn('SubscriptionUsageService.invalidateAll')(
    { self: this },
    function* (): Effect.fn.Return<void> {
      yield* Cache.invalidateAll(yield* this.usageCache);
    },
  );

  getUsage(
    provider: SubscriptionUsageProvider,
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
        onFailure: Effect.fn('onFailure')({ self: this }, function* (cause) {
          const error = Cause.squash(cause);
          yield* Effect.logWarning(
            `Subscription usage variant probe failed for ${provider}: ${toErrorMessage(error)}`,
          ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL));
          return yield* this.unavailable(provider, 'request_failed');
        }),
        onSuccess: (variant) => this.coalesced(provider, variant),
      },
    );
  }

  /** One snapshot per subscription provider, for a settings-view refresh. */
  getAllUsage(): Effect.Effect<
    SubscriptionUsageSnapshots,
    never,
    HttpClient.HttpClient | Secrets
  > {
    // Each snapshot key is the provider id itself, so key and provider can
    // never drift apart.
    return Effect.all(
      EffectRecord.map(PLAN_BY_PROVIDER, (_plan, provider) =>
        this.getUsage(provider),
      ),
      { concurrency: 'unbounded' },
    );
  }

  /** One lookup per key at a time, served from the cache while it is warm. */
  private coalesced(
    provider: SubscriptionUsageProvider,
    variant: boolean | undefined,
  ): Effect.Effect<
    SubscriptionUsageSnapshot,
    never,
    HttpClient.HttpClient | Secrets
  > {
    const key: UsageCacheKey = [provider, variant];
    return Effect.flatMap(this.usageCache, (cache) => Cache.get(cache, key));
  }

  private unavailable(
    provider: SubscriptionUsageProvider,
    reason: SubscriptionUsageUnavailableReason,
  ): Effect.Effect<SubscriptionUsageSnapshot> {
    return Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({
      state: 'unavailable',
      providerName: PLAN_BY_PROVIDER[provider].credentialName,
      planName: PLAN_BY_PROVIDER[provider].displayName,
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
      providerName: PLAN_BY_PROVIDER[provider].credentialName,
      planName: parsed.planName ?? PLAN_BY_PROVIDER[provider].displayName,
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
      Effect.catchCause(
        Effect.fnUntraced({ self: this }, function* (cause) {
          // The reason a failed fetch maps to, most specific cause first. The
          // failure classes are disjoint, so at most one of these checks
          // holds. The reason alone cannot tell a routine refusal from an
          // unexpected fault, so the cause is named once here.
          const error = Cause.squash(cause);
          // An HttpClientError carries its request, headers included (the
          // plan's API key unredacted), so only its reason is logged.
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
          if (status === 401 || status === 403) {
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
