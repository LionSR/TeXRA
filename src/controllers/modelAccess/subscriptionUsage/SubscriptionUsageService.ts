import { Deferred, Effect, Exit } from 'effect';
import { LRUCache } from 'lru-cache';

import { settleFailure } from '@auth/authProgram';
import { codexCoordinator, CodexAuthError } from '@auth/codex';
import { withLogChannel } from '@logger/effectLog';
import { exposeApiKey, lookupApiKey } from '@model/apiProviders';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSnapshots,
} from '@shared/schemas';
import { SUBSCRIPTION_USAGE_PROVIDERS } from '@shared/schemas';
import { useChinaRegion } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { fetchChatGptUsage } from './codexUsageAdapter';
import {
  fetchGlmCodingPlanUsage,
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
} from './glmCodingPlanUsageAdapter';
import { fetchKimiCodeUsage } from './kimiCodeUsageAdapter';
import {
  SubscriptionUsageHttpError,
  type ParsedSubscriptionUsage,
} from './subscriptionUsageParsing';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'SubscriptionUsage';

const CACHE_TTL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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

/** The credential stores this service reads, plus the two test-only clocks. */
interface SubscriptionUsageServiceInit {
  readonly secrets: PlatformSecrets;
  readonly stores: SettingsStores;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

/** Why a usage snapshot carries no data (the `unavailable` variant's reason). */
type SubscriptionUsageUnavailableReason = Extract<
  SubscriptionUsageSnapshot,
  { state: 'unavailable' }
>['reason'];

interface SubscriptionUsageAdapter {
  /** Credential-derived request variant (today: the GLM region flag). */
  readonly resolveVariant?: () => Effect.Effect<boolean, unknown>;
  readonly fetch: (
    variant: boolean | undefined,
  ) => Effect.Effect<
    ParsedSubscriptionUsage | null,
    unknown,
    HttpClient.HttpClient
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
  private readonly secrets: PlatformSecrets;
  private readonly stores: SettingsStores;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly adapters: Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  >;
  private readonly cache: LRUCache<string, SubscriptionUsageSnapshot>;
  private readonly pending = new Map<
    string,
    Deferred.Deferred<SubscriptionUsageSnapshot>
  >();

  constructor(init: SubscriptionUsageServiceInit) {
    this.secrets = init.secrets;
    this.stores = init.stores;
    this.now = init.now ?? Date.now;
    this.requestTimeoutMs = init.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.adapters = this.createAdapters();
    this.cache = new LRUCache({
      max: 64,
      ttl: CACHE_TTL_MS,
      // The default resolution debounces perf.now() via a real setTimeout,
      // which ignores the injected clock (this.now) entirely in tests.
      ttlResolution: 0,
      perf: { now: this.now },
    });
  }

  /** Provider transports are adapters; caching and failure policy stay common. */
  private createAdapters(): Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  > {
    // Each adapter fetch is already a program, and reaches the platform
    // `fetch` through `FetchHttpClient.Fetch` inside the request that makes
    // it, so the provider's own rejection reaches the fold below unchanged.
    const signal = (): AbortSignal =>
      AbortSignal.timeout(this.requestTimeoutMs);
    return Object.freeze({
      chatgpt: {
        fetch: () =>
          Effect.flatMap(this.loadChatGptCredential(), (credential) =>
            credential
              ? fetchChatGptUsage(credential, signal())
              : Effect.succeed(null),
          ),
      },
      kimiCode: {
        fetch: () =>
          Effect.flatMap(this.loadApiKey('kimiCode'), (apiKey) =>
            apiKey
              ? fetchKimiCodeUsage(apiKey, signal())
              : Effect.succeed(null),
          ),
      },
      glmCodingPlan: {
        resolveVariant: () => useChinaRegion(this.stores, 'glm'),
        fetch: (useChina) =>
          Effect.flatMap(this.loadApiKey('glm'), (apiKey) =>
            apiKey
              ? fetchGlmCodingPlanUsage(
                  apiKey,
                  signal(),
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
   * `CodexAuthError` it minted.
   */
  private readonly loadChatGptCredential = Effect.fn(
    'SubscriptionUsage.loadChatGptCredential',
  )(function* (this: SubscriptionUsageService) {
    const coordinator = codexCoordinator(this.secrets);
    if ((yield* coordinator.loadSession()) === null) return null;
    const session = yield* coordinator.getFreshSession();
    return {
      accessToken: session.accessToken,
      ...(session.accountId ? { accountId: session.accountId } : {}),
    };
  });

  /** A coding-plan provider's API key, from secret storage or the environment. */
  private loadApiKey(
    provider: 'kimiCode' | 'glm',
  ): Effect.Effect<string | undefined, SecretsFailed> {
    return Effect.map(lookupApiKey(this.secrets, provider), (key) =>
      key === undefined ? undefined : exposeApiKey(key),
    );
  }

  /** Drop cached and in-flight work after credentials or accounts change. */
  invalidate(provider?: SubscriptionUsageProvider): void {
    const providers = provider ? [provider] : SUBSCRIPTION_USAGE_PROVIDERS;
    for (const target of providers) {
      const keyPrefix = `${target}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(keyPrefix)) this.cache.delete(key);
      }
      for (const key of this.pending.keys()) {
        if (key.startsWith(keyPrefix)) this.pending.delete(key);
      }
    }
  }

  getUsage(
    provider: SubscriptionUsageProvider,
    options: { readonly forceRefresh?: boolean } = {},
  ): Effect.Effect<SubscriptionUsageSnapshot, never, HttpClient.HttpClient> {
    const adapter = this.adapters[provider];
    return Effect.matchCauseEffect(
      Effect.suspend(
        (): Effect.Effect<boolean | undefined, unknown> =>
          adapter.resolveVariant?.() ?? Effect.succeed(undefined),
      ),
      {
        onFailure: (cause) =>
          Effect.gen({ self: this }, function* () {
            const error = settleFailure(cause);
            yield* Effect.logWarning(
              `Subscription usage variant probe failed for ${provider}: ${toErrorMessage(error)}`,
            ).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel(CHANNEL),
            );
            return this.unavailable(provider, 'request_failed');
          }),
        onSuccess: (variant) => this.coalesced(provider, variant, options),
      },
    );
  }

  /** One snapshot per subscription provider, for a settings-view refresh. */
  getAllUsage(
    options: { readonly forceRefresh?: boolean } = {},
  ): Effect.Effect<SubscriptionUsageSnapshots, never, HttpClient.HttpClient> {
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

  /**
   * One probe per cache key at a time, served from the TTL cache while it is
   * warm. The probe runs on a detached fiber and every caller waits on the
   * same `Deferred`, so one caller's cancellation cancels only its own wait —
   * what the shared promise this replaced did by construction. The claim and
   * the fork run under one uninterruptible mask: an interrupt landing between
   * registering the deferred and starting the fiber that settles it would
   * leave every later caller waiting on an entry nothing completes.
   *
   * Return-path choice (D16, define-out-of-existence §1e): when invalidate()
   * races an in-flight probe, the identity check below keeps the stale result
   * out of the cache, but the already-waiting caller still receives it — one
   * accepted stale read on a read-only usage display.
   */
  private coalesced(
    provider: SubscriptionUsageProvider,
    variant: boolean | undefined,
    options: { readonly forceRefresh?: boolean },
  ): Effect.Effect<SubscriptionUsageSnapshot, never, HttpClient.HttpClient> {
    const key = `${provider}:${variant ?? 'default'}`;
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (options.forceRefresh) {
          this.cache.delete(key);
          this.pending.delete(key);
        }
        const cached = this.cache.get(key);
        if (cached !== undefined) return Effect.succeed(cached);
        const inFlight = this.pending.get(key);
        if (inFlight !== undefined) return restore(Deferred.await(inFlight));

        const request = Deferred.makeUnsafe<SubscriptionUsageSnapshot>();
        this.pending.set(key, request);
        return Effect.flatMap(
          Effect.forkDetach(
            this.fetchUsage(provider, variant).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (this.pending.get(key) === request) {
                    this.pending.delete(key);
                    if (Exit.isSuccess(exit)) {
                      this.cache.set(key, exit.value);
                    }
                  }
                  Deferred.doneUnsafe(request, exit);
                }),
              ),
            ),
          ),
          () => restore(Deferred.await(request)),
        );
      }),
    );
  }

  private unavailable(
    provider: SubscriptionUsageProvider,
    reason: SubscriptionUsageUnavailableReason,
  ): SubscriptionUsageSnapshot {
    return {
      state: 'unavailable',
      provider,
      providerName: PROVIDER_NAMES[provider],
      planName: DEFAULT_PLAN_NAMES[provider],
      windows: [],
      fetchedAt: this.now(),
      reason,
    };
  }

  private available(
    provider: SubscriptionUsageProvider,
    parsed: ParsedSubscriptionUsage,
  ): SubscriptionUsageSnapshot {
    return {
      state: 'available',
      provider,
      providerName: PROVIDER_NAMES[provider],
      planName: parsed.planName ?? DEFAULT_PLAN_NAMES[provider],
      windows: [...parsed.windows],
      fetchedAt: this.now(),
    };
  }

  private fetchUsage(
    provider: SubscriptionUsageProvider,
    variant: boolean | undefined,
  ): Effect.Effect<SubscriptionUsageSnapshot, never, HttpClient.HttpClient> {
    return Effect.suspend(() => this.adapters[provider].fetch(variant)).pipe(
      Effect.map((parsed) => {
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
          const error = settleFailure(cause);
          yield* Effect.logWarning(
            `Subscription usage fetch failed for ${provider}: ${toErrorMessage(error)}`,
          ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL));
          const invalidCredentials =
            (error instanceof CodexAuthError && error.needsReauth) ||
            (error instanceof SubscriptionUsageHttpError &&
              (error.status === 401 || error.status === 403));
          if (invalidCredentials) {
            return this.unavailable(provider, 'invalid_credentials');
          }
          if (error instanceof SyntaxError) {
            return this.unavailable(provider, 'malformed_response');
          }
          return this.unavailable(provider, 'request_failed');
        }),
      ),
    );
  }
}
