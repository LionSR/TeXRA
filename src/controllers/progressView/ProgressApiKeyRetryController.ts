// Local imports
import type { ApiProvider } from '@model/apiProviders';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import type { ExhaustionReason, StreamTabId } from '@shared/schemas';

export interface ProgressApiKeyRetryRequest {
  stream: StreamTabId;
  requestId: string;
  provider?: ApiProvider;
  /** Canonical base model the fallback run will launch with, when known. */
  model?: string;
  exhaustionReason?: ExhaustionReason;
  chatGptSubscriptionEligible?: boolean;
  viaRelay?: boolean;
}

interface ProgressApiKeyPreparationResult {
  proceeded: boolean;
  disabledIncludedModelAccess: boolean;
  disabledChatGptSubscription: boolean;
  disabledKimiCodeSubscription: boolean;
}

export interface ProgressApiKeyRetryResult extends ProgressApiKeyPreparationResult {
  retried: boolean;
}

interface ProgressApiRoutingSnapshot {
  readonly useIncludedModelAccess: boolean;
  readonly preferChatGptSubscription: boolean;
  readonly preferKimiCode: boolean;
}

function noRetryResult(): ProgressApiKeyRetryResult {
  return {
    proceeded: false,
    retried: false,
    disabledIncludedModelAccess: false,
    disabledChatGptSubscription: false,
    disabledKimiCodeSubscription: false,
  };
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(provider: ApiProvider): Promise<string | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  getUseIncludedModelAccess(): boolean;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
  getPreferChatGptSubscription(): boolean;
  setPreferChatGptSubscription(enabled: boolean): Promise<void>;
  getPreferKimiCode(): boolean;
  setPreferKimiCode(enabled: boolean): Promise<void>;
  invalidateModelOptionsCache(): void;
  isRetryPending(stream: StreamTabId, requestId: string): boolean;
  triggerRetry(stream: StreamTabId, requestId: string): boolean;
}

/**
 * Owns the policy for switching from relay access to user-provided keys.
 *
 * The progress view host still owns prompts and messages; this controller keeps
 * the credential/retry rules testable without depending on VS Code APIs.
 */
export class ProgressApiKeyRetryController {
  constructor(private readonly deps: ProgressApiKeyRetryControllerDeps) {}

  async useOwnApiKey(
    request: ProgressApiKeyRetryRequest,
  ): Promise<ProgressApiKeyRetryResult> {
    const proceeded = await this.ensureOwnApiKey(request);
    if (
      !proceeded ||
      !this.deps.isRetryPending(request.stream, request.requestId)
    ) {
      return noRetryResult();
    }

    const routingBefore = this.routingSnapshot();
    const prepared = await this.applyOwnApiKeyRouting(request);
    const retried = this.deps.triggerRetry(request.stream, request.requestId);
    if (!retried) {
      await this.restoreOwnApiKeyRouting(routingBefore, prepared);
      return noRetryResult();
    }
    return {
      ...prepared,
      retried: true,
    };
  }

  async ensureOwnApiKey(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): Promise<boolean> {
    const providersToCheck = request.provider
      ? [request.provider]
      : this.deps.providers;
    const requireChange = request.exhaustionReason === 'upstream-credit';

    // The gate depends on which credential failed:
    // - Upstream credit depletion means the stored direct key is the broken
    //   credential, so the user must provide a changed usable key.
    // - Relay monthly limits do not imply a broken direct key, so any usable
    //   direct key is enough consent to retry outside the relay.
    // Do not use "any API key exists" here; that also treats relay access as a
    // credential, which would allow retrying without a usable direct key.
    if (requireChange) {
      const before = await this.readKeys(providersToCheck);
      await this.deps.promptForApiKey(request.provider);
      return this.hasChangedUsableKey(providersToCheck, before);
    }

    // Relay/subscription exhaustion does not break the stored direct key, so
    // if a usable one already exists, switch to it and retry without
    // re-prompting, since the user has already provided a key. Only prompt when
    // none exists yet, and only re-check the keys after that prompt (so the
    // common already-set path reads the secret store once, not twice).
    if (await this.hasAnyUsableKey(providersToCheck)) return true;
    await this.deps.promptForApiKey(request.provider);
    return this.hasAnyUsableKey(providersToCheck);
  }

  private shouldDisableIncludedModelAccess(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    return (
      request.viaRelay === true ||
      request.exhaustionReason === 'chatgpt-subscription' ||
      request.exhaustionReason === 'copilot-subscription' ||
      request.exhaustionReason === 'kimi-code-subscription'
    );
  }

  private isSubscriptionExhausted(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    if (request.exhaustionReason === 'chatgpt-subscription') return true;
    return (
      request.exhaustionReason === 'copilot-subscription' &&
      request.chatGptSubscriptionEligible === true
    );
  }

  private isKimiCodeSubscriptionExhausted(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    return request.exhaustionReason === 'kimi-code-subscription';
  }

  private async applyOwnApiKeyRouting(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): Promise<ProgressApiKeyPreparationResult> {
    // Disable relay (included access) so the retry uses the user's own key,
    // not the relay JWT, whenever the switch promises "your own API key".
    // Both relay and subscription exhaustion fall through to a direct handler,
    // which otherwise may still prefer included access over the stored key.
    // A direct-key failure leaves relay untouched for other providers.
    let disabledIncludedModelAccess = false;
    if (this.shouldDisableIncludedModelAccess(request)) {
      await this.deps.setUseIncludedModelAccess(false);
      this.deps.invalidateModelOptionsCache();
      disabledIncludedModelAccess = true;
    }

    // The subscription quota is exhausted, so turn off the preference and let
    // Codex-eligible models route through the now-usable OpenAI key on retry.
    // Remark: prefer-off sticks after the quota resets — users may forget to
    // re-enable it. A temporary / resume-on-reset override would be kinder.
    let disabledChatGptSubscription = false;
    if (
      this.deps.getPreferChatGptSubscription() &&
      this.isSubscriptionExhausted(request)
    ) {
      await this.deps.setPreferChatGptSubscription(false);
      this.deps.invalidateModelOptionsCache();
      disabledChatGptSubscription = true;
    }

    // Kimi Code quota exhausted: turn off "Prefer Kimi Code" so dual-backend
    // Kimi models (e.g. `kimi3`) re-route through the Moonshot open-platform
    // API key on retry. Exclusive Kimi Code models have no open-platform route
    // and cannot fall back this way.
    let disabledKimiCodeSubscription = false;
    if (
      this.deps.getPreferKimiCode() &&
      this.isKimiCodeSubscriptionExhausted(request)
    ) {
      await this.deps.setPreferKimiCode(false);
      this.deps.invalidateModelOptionsCache();
      disabledKimiCodeSubscription = true;
    }

    return {
      proceeded: true,
      disabledIncludedModelAccess,
      disabledChatGptSubscription,
      disabledKimiCodeSubscription,
    };
  }

  /** Apply Copilot fallback routing only for the duration of a launch attempt. */
  async runCopilotFallbackWithRouting(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
    start: (copilotRouteOverride: CopilotRouteOverride) => Promise<boolean>,
  ): Promise<boolean> {
    const before = this.routingSnapshot();
    const prepared = await this.applyOwnApiKeyRouting(request);
    // The user chose "use own API key" for this retry. The direct-route
    // override travels only with the replacement launch; the standing
    // preference remains visible to concurrent and future runs.
    let started = false;
    try {
      started = await start('direct');
      return started;
    } finally {
      if (!started) await this.restoreOwnApiKeyRouting(before, prepared);
    }
  }

  private routingSnapshot(): ProgressApiRoutingSnapshot {
    return {
      useIncludedModelAccess: this.deps.getUseIncludedModelAccess(),
      preferChatGptSubscription: this.deps.getPreferChatGptSubscription(),
      preferKimiCode: this.deps.getPreferKimiCode(),
    };
  }

  private async restoreOwnApiKeyRouting(
    before: ProgressApiRoutingSnapshot,
    prepared: ProgressApiKeyPreparationResult,
  ): Promise<void> {
    const restores: Promise<void>[] = [];
    if (prepared.disabledIncludedModelAccess) {
      restores.push(
        this.deps.setUseIncludedModelAccess(before.useIncludedModelAccess),
      );
    }
    if (prepared.disabledChatGptSubscription) {
      restores.push(
        this.deps.setPreferChatGptSubscription(
          before.preferChatGptSubscription,
        ),
      );
    }
    if (prepared.disabledKimiCodeSubscription) {
      restores.push(this.deps.setPreferKimiCode(before.preferKimiCode));
    }
    await Promise.all(restores);
    if (restores.length > 0) this.deps.invalidateModelOptionsCache();
  }

  private async hasAnyUsableKey(
    providers: readonly ApiProvider[],
  ): Promise<boolean> {
    const checks = await Promise.all(
      providers.map((provider) => this.deps.hasUsableKey(provider)),
    );
    return checks.some(Boolean);
  }

  private async hasChangedUsableKey(
    providers: readonly ApiProvider[],
    keysBefore: ReadonlyMap<ApiProvider, string | undefined>,
  ): Promise<boolean> {
    const keysAfter = await this.readKeys(providers);
    return providers.some((provider) => {
      const next = keysAfter.get(provider);
      return (
        typeof next === 'string' &&
        next.trim().length > 0 &&
        next !== keysBefore.get(provider)
      );
    });
  }

  private async readKeys(
    providers: readonly ApiProvider[],
  ): Promise<Map<ApiProvider, string | undefined>> {
    return new Map(
      await Promise.all(
        providers.map(
          async (provider) =>
            [provider, await this.deps.readKey(provider)] as const,
        ),
      ),
    );
  }
}
