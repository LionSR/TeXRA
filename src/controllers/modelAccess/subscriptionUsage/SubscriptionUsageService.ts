import { codexCoordinator, CodexAuthError } from '@auth/codex';
import { lookupApiKey } from '@model/apiProviders';
import { platform } from '@platform/platform';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
import { getGLMUseChina } from '@utils/config/providerConfig';

import {
  fetchChatGptUsage,
  type ChatGptUsageCredential,
  type SubscriptionUsageHttp,
} from './codexUsageAdapter';
import {
  fetchGlmCodingPlanUsage,
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
} from './glmCodingPlanUsageAdapter';
import { fetchKimiCodeUsage } from './kimiCodeUsageAdapter';
import { SubscriptionUsageHttpError } from './subscriptionUsageParsing';
import type { ParsedSubscriptionUsage } from './subscriptionUsageTypes';

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const PROVIDER_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT',
  kimiCode: 'Kimi Code',
  glmCodingPlan: 'GLM',
  grok: 'Grok',
};

const DEFAULT_PLAN_NAMES: Record<SubscriptionUsageProvider, string> = {
  chatgpt: 'ChatGPT Coding Plan',
  kimiCode: 'Kimi Code',
  glmCodingPlan: 'GLM Coding Plan',
  grok: 'Grok subscription',
};

export interface SubscriptionUsageCredentials {
  loadChatGpt(): Promise<ChatGptUsageCredential | null>;
  loadApiKey(provider: 'kimiCode' | 'glm'): Promise<string | undefined>;
  /** Defaults to the China endpoint when omitted by an injected test/client. */
  useGlmChina?(): boolean | Promise<boolean>;
}

export interface SubscriptionUsageServiceInit {
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

const DEFAULT_CREDENTIALS: SubscriptionUsageCredentials = Object.freeze({
  async loadChatGpt(): Promise<ChatGptUsageCredential | null> {
    const session = await codexCoordinator().getFreshSession();
    return {
      accessToken: session.accessToken,
      ...(session.accountId ? { accountId: session.accountId } : {}),
    };
  },
  loadApiKey(provider: 'kimiCode' | 'glm'): Promise<string | undefined> {
    return lookupApiKey(platform().secrets, provider);
  },
  useGlmChina: getGLMUseChina,
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
  private readonly cache = new Map<SubscriptionUsageProvider, CacheEntry>();
  private readonly pending = new Map<
    SubscriptionUsageProvider,
    Promise<SubscriptionUsageSnapshot>
  >();
  private readonly generations = new Map<SubscriptionUsageProvider, number>();

  constructor(init: SubscriptionUsageServiceInit = {}) {
    this.http = init.http ?? fetch;
    this.credentials = init.credentials ?? DEFAULT_CREDENTIALS;
    this.now = init.now ?? Date.now;
    this.cacheTtlMs = init.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = init.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Drop cached and in-flight work after credentials or accounts change. */
  invalidate(provider?: SubscriptionUsageProvider): void {
    const providers = provider
      ? [provider]
      : (Object.keys(PROVIDER_NAMES) as SubscriptionUsageProvider[]);
    for (const target of providers) {
      this.cache.delete(target);
      this.pending.delete(target);
      this.generations.set(target, (this.generations.get(target) ?? 0) + 1);
    }
  }

  async getUsage(
    provider: SubscriptionUsageProvider,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<SubscriptionUsageSnapshot> {
    if (!options.forceRefresh) {
      const cached = this.cache.get(provider);
      if (cached && cached.expiresAt > this.now()) return cached.snapshot;
    }

    const inFlight = this.pending.get(provider);
    if (inFlight) return inFlight;

    const generation = this.generations.get(provider) ?? 0;
    const request = this.fetchUsage(provider).then((snapshot) => {
      if ((this.generations.get(provider) ?? 0) !== generation) {
        return this.getUsage(provider, { forceRefresh: true });
      }
      if (this.pending.get(provider) === request) {
        this.cache.set(provider, {
          snapshot,
          expiresAt: this.now() + this.cacheTtlMs,
        });
      }
      return snapshot;
    });
    this.pending.set(provider, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(provider) === request) this.pending.delete(provider);
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
  ): Promise<SubscriptionUsageSnapshot> {
    if (provider === 'grok') return this.unavailable(provider, 'unsupported');

    try {
      const parsed = await this.fetchProviderUsage(provider);
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

  private async fetchProviderUsage(
    provider: Exclude<SubscriptionUsageProvider, 'grok'>,
  ): Promise<ParsedSubscriptionUsage | null> {
    if (provider === 'chatgpt') {
      const credential = await this.credentials.loadChatGpt();
      if (!credential) return null;
      return fetchChatGptUsage(
        this.http,
        credential,
        AbortSignal.timeout(this.requestTimeoutMs),
      );
    }
    if (provider === 'kimiCode') {
      const apiKey = await this.credentials.loadApiKey('kimiCode');
      if (!apiKey) return null;
      return fetchKimiCodeUsage(
        this.http,
        apiKey,
        AbortSignal.timeout(this.requestTimeoutMs),
      );
    }
    const apiKey = await this.credentials.loadApiKey('glm');
    if (!apiKey) return null;
    const useChina = (await this.credentials.useGlmChina?.()) ?? true;
    return fetchGlmCodingPlanUsage(
      this.http,
      apiKey,
      AbortSignal.timeout(this.requestTimeoutMs),
      useChina
        ? GLM_CODING_PLAN_USAGE_URL
        : GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
    );
  }
}
