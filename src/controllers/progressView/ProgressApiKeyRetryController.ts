// Local imports
import type { ApiProvider } from '@model/apiProviders';
import { codingPlanSubscriptionRuntimes } from '@model/codingPlanSubscriptions';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import type { ExhaustionReason, StreamTabId } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';

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

/**
 * One API-key-based coding-plan subscription (GLM Coding Plan, Kimi Code) that
 * the retry controller can turn off when its quota is exhausted. Both share the
 * same shape: a toggle that routes requests through a coding endpoint, and a
 * quota-exhaustion reason that signals the toggle should be disabled so requests
 * re-route through the regular pay-as-you-go endpoint.
 */
interface CodingPlanToggle {
  /** The exhaustion reason that signals this plan's quota ran out. */
  readonly exhaustionReason: ExhaustionReason;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly restoreEnabled?: (enabled: boolean) => Promise<void>;
}

interface ProgressApiKeyPreparationResult {
  proceeded: boolean;
  disabledIncludedModelAccess: boolean;
  disabledChatGptSubscription: boolean;
  /** Exhaustion reasons whose coding-plan toggle was turned off. */
  disabledCodingPlans: readonly ExhaustionReason[];
}

export interface ProgressApiKeyRetryResult extends ProgressApiKeyPreparationResult {
  retried: boolean;
}

interface ProgressApiRoutingSnapshot {
  readonly useIncludedModelAccess: boolean;
  readonly preferChatGptSubscription: boolean;
  readonly codingPlans: ReadonlyMap<ExhaustionReason, boolean>;
}

function noRetryResult(): ProgressApiKeyRetryResult {
  return {
    proceeded: false,
    retried: false,
    disabledIncludedModelAccess: false,
    disabledChatGptSubscription: false,
    disabledCodingPlans: [],
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
  /** API-key-based coding-plan subscriptions (GLM Coding Plan, Kimi Code). */
  codingPlanToggles?: readonly CodingPlanToggle[];
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

  private get codingPlanToggles(): readonly CodingPlanToggle[] {
    return (
      this.deps.codingPlanToggles ??
      codingPlanSubscriptionRuntimes.map((runtime) => ({
        exhaustionReason: runtime.descriptor.exhaustionReason,
        getEnabled: runtime.getEnabled,
        setEnabled: runtime.setEnabled,
        restoreEnabled: runtime.restoreEnabled,
      }))
    );
  }

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
    const provider = this.resolveProvider(request);
    const providersToCheck = provider ? [provider] : this.deps.providers;
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
      await this.deps.promptForApiKey(provider);
      return this.hasChangedUsableKey(providersToCheck, before);
    }

    // Relay/subscription exhaustion does not break the stored direct key, so
    // if a usable one already exists, switch to it and retry without
    // re-prompting, since the user has already provided a key. Only prompt when
    // none exists yet, and only re-check the keys after that prompt (so the
    // common already-set path reads the secret store once, not twice).
    if (await this.hasAnyUsableKey(providersToCheck)) return true;
    await this.deps.promptForApiKey(provider);
    return this.hasAnyUsableKey(providersToCheck);
  }

  /**
   * ChatGPT/Codex subscription exhaustion always means the OpenAI key is the
   * fallback credential — that auth mode is OpenAI-only (see
   * `providerCapabilities.ts`) — regardless of how the error tagged provider.
   */
  private resolveProvider(
    request: Pick<ProgressApiKeyRetryRequest, 'provider' | 'exhaustionReason'>,
  ): ApiProvider | undefined {
    return request.exhaustionReason === 'chatgpt-subscription'
      ? 'openai'
      : request.provider;
  }

  private shouldDisableIncludedModelAccess(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    return (
      request.viaRelay === true ||
      request.exhaustionReason === 'chatgpt-subscription' ||
      request.exhaustionReason === 'copilot-subscription'
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

    // Any API-key-based coding-plan subscription (GLM Coding Plan, Kimi Code)
    // whose quota is exhausted: turn off its toggle so requests re-route through
    // the regular pay-as-you-go endpoint on retry.
    const disabledCodingPlans: ExhaustionReason[] = [];
    for (const toggle of this.codingPlanToggles) {
      if (
        toggle.getEnabled() &&
        request.exhaustionReason === toggle.exhaustionReason
      ) {
        await toggle.setEnabled(false);
        this.deps.invalidateModelOptionsCache();
        disabledCodingPlans.push(toggle.exhaustionReason);
      }
    }

    return {
      proceeded: true,
      disabledIncludedModelAccess,
      disabledChatGptSubscription,
      disabledCodingPlans,
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
      codingPlans: new Map(
        this.codingPlanToggles.map((toggle) => [
          toggle.exhaustionReason,
          toggle.getEnabled(),
        ]),
      ),
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
    for (const reason of prepared.disabledCodingPlans) {
      const toggle = this.codingPlanToggles.find(
        (candidate) => candidate.exhaustionReason === reason,
      );
      if (toggle)
        restores.push(
          (toggle.restoreEnabled ?? toggle.setEnabled)(
            before.codingPlans.get(reason) ?? false,
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
    keysBefore: ReadonlyMap<ApiProvider, string | undefined>,
  ): Promise<boolean> {
    const keysAfter = await this.readKeys(providers);
    return providers.some((provider) => {
      const next = keysAfter.get(provider);
      return isNonEmptyString(next) && next !== keysBefore.get(provider);
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
