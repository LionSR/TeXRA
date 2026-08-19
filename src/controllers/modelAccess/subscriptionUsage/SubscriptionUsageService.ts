import { codexCoordinator, CodexAuthError } from '@auth/codex';
import { lookupApiKey } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
import { SUBSCRIPTION_USAGE_PROVIDERS } from '@shared/schemas';
import { useChinaRegion } from '@utils/config/providerConfig';

import {
  fetchChatGptUsage,
  type ChatGptUsageCredential,
} from './codexUsageAdapter';
import {
  fetchGlmCodingPlanUsage,
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
} from './glmCodingPlanUsageAdapter';
import { fetchKimiCodeUsage } from './kimiCodeUsageAdapter';
import {
  SubscriptionUsageHttpError,
  type ParsedSubscriptionUsage,
  type SubscriptionUsageHttp,
} from './subscriptionUsageParsing';

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CODING_PLAN_PROVIDER_NAMES = Object.fromEntries(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [
    plan.usageProvider,
    plan.credentialName,
  ]),
) as Record<
  (typeof CODING_PLAN_SUBSCRIPTIONS)[number]['usageProvider'],
  string
>;

const CODING_PLAN_DEFAULT_NAMES = Object.fromEntries(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [
    plan.usageProvider,
    plan.displayName,
  ]),
) as Record<
  (typeof CODING_PLAN_SUBSCRIPTIONS)[number]['usageProvider'],
  string
>;

const PROVIDER_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT',
  ...CODING_PLAN_PROVIDER_NAMES,
};

export const DEFAULT_PLAN_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT Coding Plan',
  ...CODING_PLAN_DEFAULT_NAMES,
};

export interface SubscriptionUsageCredentials {
  loadChatGpt(): Promise<ChatGptUsageCredential | null>;
  loadApiKey(provider: 'kimiCode' | 'glm'): Promise<string | undefined>;
  /** Defaults to the China endpoint when omitted by an injected test/client. */
  useGlmChina?(): boolean | Promise<boolean>;
}

interface SubscriptionUsageServiceInit {
  readonly http?: SubscriptionUsageHttp;
  readonly credentials?: SubscriptionUsageCredentials;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly requestTimeoutMs?: number;
}

interface CacheEntry {
  readonly snapshot: SubscriptionUsageSnapshot;
  readonly expiresAt: number;
}

interface SubscriptionUsageAdapter {
  readonly resolveVariant?: () => boolean | string | Promise<boolean | string>;
  readonly fetch: (
    variant: boolean | string | undefined,
  ) => Promise<ParsedSubscriptionUsage | null>;
}

const DEFAULT_CREDENTIALS: SubscriptionUsageCredentials = Object.freeze({
  async loadChatGpt(): Promise<ChatGptUsageCredential | null> {
    const coordinator = codexCoordinator();
    if (!(await coordinator.loadSession())) return null;
    const session = await coordinator.getFreshSession();
    return {
      accessToken: session.accessToken,
      ...(session.accountId ? { accountId: session.accountId } : {}),
    };
  },
  loadApiKey(provider: 'kimiCode' | 'glm'): Promise<string | undefined> {
    return lookupApiKey(platform().secrets, provider);
  },
  useGlmChina: () => useChinaRegion('glm'),
});

/**
 * Read-only, host-neutral access to coding-plan usage. Results are short-lived,
 * coalesced per provider, and always resolve to a snapshot instead of exposing
 * provider transport failures to extension or CLI consumers.
 */
export class SubscriptionUsageService {
  private readonly http: SubscriptionUsageHttp;
  private readonly credentials: SubscriptionUsageCredentials;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly adapters: Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  >;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<
    string,
    Promise<SubscriptionUsageSnapshot>
  >();

  constructor(init: SubscriptionUsageServiceInit = {}) {
    this.http = init.http ?? fetch;
    this.credentials = init.credentials ?? DEFAULT_CREDENTIALS;
    this.now = init.now ?? Date.now;
    this.cacheTtlMs = init.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = init.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.adapters = this.createAdapters();
  }

  /** Provider transports are adapters; caching and failure policy stay common. */
  private createAdapters(): Readonly<
    Record<SubscriptionUsageProvider, SubscriptionUsageAdapter>
  > {
    const signal = (): AbortSignal =>
      AbortSignal.timeout(this.requestTimeoutMs);
    return Object.freeze({
      chatgpt: {
        fetch: async () => {
          const credential = await this.credentials.loadChatGpt();
          return credential
            ? fetchChatGptUsage(this.http, credential, signal())
            : null;
        },
      },
      kimiCode: {
        fetch: async () => {
          const apiKey = await this.credentials.loadApiKey('kimiCode');
          return apiKey
            ? fetchKimiCodeUsage(this.http, apiKey, signal())
            : null;
        },
      },
      glmCodingPlan: {
        resolveVariant: () => this.credentials.useGlmChina?.() ?? true,
        fetch: async (useChina) => {
          const apiKey = await this.credentials.loadApiKey('glm');
          if (!apiKey) return null;
          return fetchGlmCodingPlanUsage(
            this.http,
            apiKey,
            signal(),
            (useChina ?? true)
              ? GLM_CODING_PLAN_USAGE_URL
              : GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
          );
        },
      },
    });
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

  async getUsage(
    provider: SubscriptionUsageProvider,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<SubscriptionUsageSnapshot> {
    const adapter = this.adapters[provider];
    let variant: boolean | string | undefined;
    try {
      variant = await adapter.resolveVariant?.();
    } catch {
      return this.unavailable(provider, 'request_failed');
    }
    const key = `${provider}:${variant ?? 'default'}`;

    if (options.forceRefresh) {
      this.cache.delete(key);
      this.pending.delete(key);
    } else {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.now()) return cached.snapshot;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    // Return-path choice (D16, define-out-of-existence §1e): when invalidate()
    // races an in-flight fetch, the identity check below keeps the stale result
    // out of the cache, but the already-waiting caller still receives it — one
    // accepted stale read on a read-only usage display.
    const request = this.fetchUsage(provider, variant).then((snapshot) => {
      if (this.pending.get(key) === request) {
        this.cache.set(key, {
          snapshot,
          expiresAt: this.now() + this.cacheTtlMs,
        });
      }
      return snapshot;
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) {
        this.pending.delete(key);
      }
    }
  }

  private unavailable(
    provider: SubscriptionUsageProvider,
    reason: Extract<
      SubscriptionUsageSnapshot,
      { state: 'unavailable' }
    >['reason'],
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

  private async fetchUsage(
    provider: SubscriptionUsageProvider,
    variant: boolean | string | undefined,
  ): Promise<SubscriptionUsageSnapshot> {
    try {
      const parsed = await this.adapters[provider].fetch(variant);
      if (parsed === null) {
        return this.unavailable(provider, 'missing_credentials');
      }
      if (parsed.windows.length === 0) {
        return this.unavailable(provider, 'malformed_response');
      }
      return this.available(provider, parsed);
    } catch (error: unknown) {
      let reason: Extract<
        SubscriptionUsageSnapshot,
        { state: 'unavailable' }
      >['reason'] = 'request_failed';
      if (error instanceof SyntaxError) reason = 'malformed_response';
      if (error instanceof CodexAuthError && error.needsReauth) {
        reason = 'invalid_credentials';
      }
      if (
        error instanceof SubscriptionUsageHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        reason = 'invalid_credentials';
      }
      return this.unavailable(provider, reason);
    }
  }
}
