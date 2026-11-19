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

import { apiKey, providerDisplayName } from '@texra-ai/llm';
import {
  fetchPlanUsage,
  type PlanUsage,
  type PlanUsageRequest,
} from '@texra-ai/llm/node';
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
import type { HttpClient } from 'effect/http';

const CHANNEL = 'SubscriptionUsage';

const CACHE_TTL = Duration.seconds(30);

const [KIMI_CODE_PLAN, GLM_CODING_PLAN] = CODING_PLAN_SUBSCRIPTIONS;

/** Each subscription's catalog plan, by the provider that reports its usage. */
const PLAN_BY_PROVIDER = {
  [KIMI_CODE_PLAN.id]: KIMI_CODE_PLAN,
  [GLM_CODING_PLAN.id]: GLM_CODING_PLAN,
} satisfies Record<SubscriptionUsageProvider, CodingPlanSubscription>;

/** The setting slots this service reads; credentials come from the process
 *  `Secrets`. */
interface SubscriptionUsageServiceInit {
  readonly stores: SettingsStores;
}

/** One cache entry per plan and, for GLM, the platform its key is on. */
type UsageCacheKey =
  | readonly ['kimiCode']
  | readonly ['glmCodingPlan', 'china' | 'international'];

/** Why a usage snapshot carries no data (the `unavailable` variant's reason). */
type SubscriptionUsageUnavailableReason = Extract<
  SubscriptionUsageSnapshot,
  { state: 'unavailable' }
>['reason'];

/**
 * Read-only, host-neutral access to coding-plan usage. Every read is a
 * program: results are short-lived, coalesced per provider, and always
 * succeed with a snapshot rather than exposing provider transport failures to
 * extension or CLI consumers — the failure channel is `never`, so a caller
 * has no error case to write.
 */
export class SubscriptionUsageService {
  private readonly stores: SettingsStores;
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
          Cache.makeWith((key: UsageCacheKey) => this.fetchUsage(key), {
            capacity: 64,
            timeToLive: () => CACHE_TTL,
            requireServicesAt: 'lookup',
          }),
          (made) => (this.cache ??= made),
        ),
  );

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
    // The GLM region decides which platform's quota endpoint is asked.
    const key: Effect.Effect<UsageCacheKey, Error> =
      provider === 'glmCodingPlan'
        ? Effect.map(
            Settings.get(this.stores, GLM_REGION_SETTING),
            (china) => [provider, china ? 'china' : 'international'] as const,
          )
        : Effect.succeed([provider] as const);
    return Effect.matchCauseEffect(key, {
      onFailure: Effect.fn('onFailure')({ self: this }, function* (cause) {
        const error = Cause.squash(cause);
        yield* Effect.logWarning(
          `Subscription usage variant probe failed for ${provider}: ${toErrorMessage(error)}`,
        ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL));
        return yield* this.unavailable(provider, 'request_failed');
      }),
      // One lookup per key at a time, served from the cache while it is warm.
      onSuccess: (key) =>
        Effect.flatMap(this.usageCache, (cache) => Cache.get(cache, key)),
    });
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

  private unavailable(
    provider: SubscriptionUsageProvider,
    reason: SubscriptionUsageUnavailableReason,
  ): Effect.Effect<SubscriptionUsageSnapshot> {
    return Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({
      state: 'unavailable',
      providerName: providerDisplayName(PLAN_BY_PROVIDER[provider].apiProvider),
      planName: PLAN_BY_PROVIDER[provider].displayName,
      windows: [],
      fetchedAt,
      reason,
    }));
  }

  private available(
    provider: SubscriptionUsageProvider,
    parsed: PlanUsage,
  ): Effect.Effect<SubscriptionUsageSnapshot> {
    return Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({
      state: 'available',
      providerName: providerDisplayName(PLAN_BY_PROVIDER[provider].apiProvider),
      planName: parsed.planName ?? PLAN_BY_PROVIDER[provider].displayName,
      windows: [...parsed.windows],
      fetchedAt,
    }));
  }

  /** One plan's snapshot from its provider, with the key `Secrets` holds.
   *  The client's own failure reaches the handler below unchanged. */
  private fetchUsage(
    key: UsageCacheKey,
  ): Effect.Effect<
    SubscriptionUsageSnapshot,
    never,
    HttpClient.HttpClient | Secrets
  > {
    const [provider] = key;
    const request: PlanUsageRequest =
      key[0] === 'glmCodingPlan'
        ? { plan: 'glm', region: key[1] }
        : { plan: 'kimiCode' };
    return Effect.flatMap(Secrets, (secrets) =>
      apiKey(secrets, request.plan),
    ).pipe(
      Effect.flatMap(({ value }) =>
        value ? fetchPlanUsage(request, value) : Effect.succeed(null),
      ),
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
