// Local imports - model
import type { ApiProvider } from '@model/apiProviders';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

export interface ProgressApiKeyRetryRequest {
  stream: StreamTabId;
  provider?: ApiProvider;
  upstreamCreditDepleted?: boolean;
  viaRelay?: boolean;
  /** True when the failing request ran through the ChatGPT subscription
   *  (Codex backend) and hit its usage limit. Accepting the switch turns off
   *  the "prefer ChatGPT subscription" preference so the retry routes through
   *  the user's OpenAI API key instead. Orthogonal to `viaRelay`. */
  chatgptSubscription?: boolean;
}

export interface ProgressApiKeyRetryResult {
  proceeded: boolean;
  retried: boolean;
  disabledIncludedModelAccess: boolean;
  disabledChatGptSubscription: boolean;
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(provider: ApiProvider): Promise<string | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
  /** Turn off the "prefer ChatGPT subscription" (Codex) preference so
   *  Codex-eligible models fall back to the OpenAI API-key path. */
  disablePreferCodexSubscription(): Promise<void>;
  invalidateModelOptionsCache(): void;
  triggerRetry(stream: StreamTabId): boolean;
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
    const providersToCheck = request.provider
      ? [request.provider]
      : this.deps.providers;
    const requireChange = request.upstreamCreditDepleted === true;

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
      await this.deps.promptForApiKey(request.provider);
      shouldProceed = await this.hasAnyUsableKey(providersToCheck);
    }

    if (!shouldProceed) {
      return {
        proceeded: false,
        retried: false,
        disabledIncludedModelAccess: false,
        disabledChatGptSubscription: false,
      };
    }

    // Disable relay (included access) so the retry uses the user's own key —
    // not the relay JWT — whenever the switch promises "your own API key".
    // Both relay exhaustion (viaRelay) and subscription exhaustion
    // (chatgptSubscription) fall through to `super.getApiKey()`, which otherwise
    // still prefers relay when included access is on, so the retry would never
    // reach the stored OpenAI key the UI describes. A direct-key failure
    // (neither flag) leaves relay untouched for other providers.
    let disabledIncludedModelAccess = false;
    if (request.viaRelay === true || request.chatgptSubscription === true) {
      await this.deps.setUseIncludedModelAccess(false);
      this.deps.invalidateModelOptionsCache();
      disabledIncludedModelAccess = true;
    }

    // The subscription quota is exhausted, so turn off the preference and let
    // Codex-eligible models route through the now-usable OpenAI key on retry.
    let disabledChatGptSubscription = false;
    if (request.chatgptSubscription === true) {
      await this.deps.disablePreferCodexSubscription();
      this.deps.invalidateModelOptionsCache();
      disabledChatGptSubscription = true;
    }

    return {
      proceeded: true,
      retried: this.deps.triggerRetry(request.stream),
      disabledIncludedModelAccess,
      disabledChatGptSubscription,
    };
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
