// Local imports - model
import type { ApiProvider } from '@model/apiProviders';
import type { ExhaustionReason, StreamTabId } from '@shared/schemas';

// Local imports - shared

export interface ProgressApiKeyRetryRequest {
  stream: StreamTabId;
  requestId: string;
  provider?: ApiProvider;
  exhaustionReason?: ExhaustionReason;
  chatGptSubscriptionEligible?: boolean;
  viaRelay?: boolean;
}

export interface ProgressApiKeyPreparationResult {
  proceeded: boolean;
  disabledIncludedModelAccess: boolean;
  disabledChatGptSubscription: boolean;
}

export interface ProgressApiKeyRetryResult extends ProgressApiKeyPreparationResult {
  retried: boolean;
}

interface ProgressApiRoutingSnapshot {
  readonly useIncludedModelAccess: boolean;
  readonly preferChatGptSubscription: boolean;
}

function noRetryResult(): ProgressApiKeyRetryResult {
  return {
    proceeded: false,
    retried: false,
    disabledIncludedModelAccess: false,
    disabledChatGptSubscription: false,
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

    const before = this.routingSnapshot();
    const prepared = await this.applyOwnApiKeyRouting(request);
    const retried = this.deps.triggerRetry(request.stream, request.requestId);
    if (!retried) {
      await this.restoreOwnApiKeyRouting(before, prepared);
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
    let shouldProceed: boolean;
    if (requireChange) {
      const before = await this.readKeys(providersToCheck);
      await this.deps.promptForApiKey(request.provider);
      shouldProceed = await this.hasChangedUsableKey(providersToCheck, before);
    } else {
      // Relay/subscription exhaustion does not break the stored direct key, so
      // if a usable one already exists, switch to it and retry without
      // re-prompting, since the user has already provided a key. Only prompt when
      // none exists yet, and only re-check the keys after that prompt (so the
      // common already-set path reads the secret store once, not twice).
      shouldProceed = await this.hasAnyUsableKey(providersToCheck);
      if (!shouldProceed) {
        await this.deps.promptForApiKey(request.provider);
        shouldProceed = await this.hasAnyUsableKey(providersToCheck);
      }
    }

    return shouldProceed;
  }

  async applyOwnApiKeyRouting(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): Promise<ProgressApiKeyPreparationResult> {
    // Disable relay (included access) so the retry uses the user's own key,
    // not the relay JWT, whenever the switch promises "your own API key".
    // Both relay and subscription exhaustion fall through to a direct handler,
    // which otherwise may still prefer included access over the stored key.
    // A direct-key failure leaves relay untouched for other providers.
    let disabledIncludedModelAccess = false;
    if (
      request.viaRelay === true ||
      request.exhaustionReason === 'chatgpt-subscription' ||
      request.exhaustionReason === 'copilot-subscription'
    ) {
      await this.deps.setUseIncludedModelAccess(false);
      this.deps.invalidateModelOptionsCache();
      disabledIncludedModelAccess = true;
    }

    // The subscription quota is exhausted, so turn off the preference and let
    // Codex-eligible models route through the now-usable OpenAI key on retry.
    let disabledChatGptSubscription = false;
    if (
      this.deps.getPreferChatGptSubscription() &&
      (request.exhaustionReason === 'chatgpt-subscription' ||
        (request.exhaustionReason === 'copilot-subscription' &&
          request.chatGptSubscriptionEligible === true))
    ) {
      await this.deps.setPreferChatGptSubscription(false);
      this.deps.invalidateModelOptionsCache();
      disabledChatGptSubscription = true;
    }

    return {
      proceeded: true,
      disabledIncludedModelAccess,
      disabledChatGptSubscription,
    };
  }

  /** Apply Copilot fallback routing only for the duration of a launch attempt. */
  async runCopilotFallbackWithRouting(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
    start: () => Promise<boolean>,
  ): Promise<boolean> {
    const before = this.routingSnapshot();
    const prepared = await this.applyOwnApiKeyRouting(request);
    let started = false;
    try {
      started = await start();
      return started;
    } finally {
      if (!started) await this.restoreOwnApiKeyRouting(before, prepared);
    }
  }

  private routingSnapshot(): ProgressApiRoutingSnapshot {
    return {
      useIncludedModelAccess: this.deps.getUseIncludedModelAccess(),
      preferChatGptSubscription: this.deps.getPreferChatGptSubscription(),
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
    before: ReadonlyMap<ApiProvider, string | undefined>,
  ): Promise<boolean> {
    const after = await this.readKeys(providers);
    return providers.some((provider) => {
      const next = after.get(provider);
      return (
        typeof next === 'string' &&
        next.trim().length > 0 &&
        next !== before.get(provider)
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
