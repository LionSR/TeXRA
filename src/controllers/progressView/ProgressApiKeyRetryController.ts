import PQueue from 'p-queue';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import type { ApiProvider } from '@model/apiProviders';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { resolveDirectModelApiKeyProvider } from '@model/openRouterRouting';
import { quotaFallbackRuntimes } from '@model/quotaFallbackRoutes';
import type { ExhaustionReason, StreamTabId } from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiCodeSubscriptionRetryBlocked,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import { isNonEmptyString } from '@utils/core';

export interface ProgressApiKeyRetryRequest {
  stream: StreamTabId;
  requestId: string;
  provider?: ApiProvider;
  /** Canonical base model the fallback run will launch with, when known. */
  model?: string;
  exhaustionReason?: ExhaustionReason;
  /** True when the failed handler's effective config was pinned to the Kimi
   * Code coding endpoint, captured from the persisted handler before the
   * retry panel opened. */
  kimiCodeRoutedOnFailure?: boolean;
  chatGptSubscriptionEligible?: boolean;
  viaRelay?: boolean;
}

/**
 * One quota-fallback route (ChatGPT, Grok, GLM Coding Plan, Kimi Code) the
 * retry controller can turn off when its quota is exhausted. Accepting the
 * switch disables the route's preference so the same model retries on the
 * fallback credential.
 */
export interface QuotaFallbackToggle {
  readonly exhaustionReason: ExhaustionReason;
  readonly disableIncludedAccess: boolean;
  readonly fallbackApiProvider?: ApiProvider;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly restoreEnabled?: (enabled: boolean) => Promise<void>;
}

interface ProgressApiKeyPreparationResult {
  proceeded: boolean;
  disabledIncludedModelAccess: boolean;
  /** Exhaustion reasons whose quota-fallback toggle was turned off. */
  disabledQuotaRoutes: readonly ExhaustionReason[];
}

export interface ProgressApiKeyRetryResult extends ProgressApiKeyPreparationResult {
  retried: boolean;
}

interface ProgressApiRoutingSnapshot {
  readonly useIncludedModelAccess: boolean;
  readonly quotaRoutes: ReadonlyMap<ExhaustionReason, boolean>;
}

function noRetryResult(): ProgressApiKeyRetryResult {
  return {
    proceeded: false,
    retried: false,
    disabledIncludedModelAccess: false,
    disabledQuotaRoutes: [],
  };
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(provider: ApiProvider): Promise<string | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  getUseIncludedModelAccess(): boolean;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
  /** Quota-fallback routes (ChatGPT, Grok, GLM, Kimi). Defaults to the
   *  shared runtime catalog. Tests inject a local table. */
  quotaFallbackToggles?: readonly QuotaFallbackToggle[];
  invalidateModelOptionsCache(): void;
  isRetryPending(stream: StreamTabId, requestId: string): boolean;
  triggerRetry(
    stream: StreamTabId,
    requestId: string,
  ): boolean | Promise<boolean>;
}

/**
 * Owns the policy for switching from relay access to user-provided keys.
 *
 * The progress view host still owns prompts and messages; this controller keeps
 * the credential/retry rules testable without depending on VS Code APIs.
 */
export class ProgressApiKeyRetryController {
  private readonly routingCommitQueue = new PQueue({ concurrency: 1 });

  constructor(private readonly deps: ProgressApiKeyRetryControllerDeps) {}

  private credentialProviderFor(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): ApiProvider | undefined {
    if (request.model === undefined) return request.provider;
    const config = MODEL_CONFIGS[request.model];
    if (config === undefined) return request.provider;
    // The live handler rebinds through the direct-route resolver. Exclusive
    // models bind to the `kimiCode` credential even when the SDK error labels
    // the open-platform Moonshot provider, so prompt for and verify the key
    // the retry will actually use; every other model keeps the forwarded
    // provider (or the default provider sweep) unchanged.
    return isKimiCodeExclusiveModel(config)
      ? resolveDirectModelApiKeyProvider(config)
      : request.provider;
  }

  /**
   * Whether `model` is a dual-backend Kimi model (`kimi3`): eligible for the
   * Kimi Code coding endpoint but also served by the Moonshot open platform.
   * Exclusive coding-only aliases pin their `baseUrl`, so they must be kept
   * out of this branch.
   */
  private isDualBackendKimiCodeModel(model: string | undefined): boolean {
    if (model === undefined) return false;
    const config = MODEL_CONFIGS[model];
    return (
      config !== undefined &&
      isKimiSubscriptionEligible(config) &&
      !isKimiCodeExclusiveModel(config)
    );
  }

  private get quotaFallbackToggles(): readonly QuotaFallbackToggle[] {
    return (
      this.deps.quotaFallbackToggles ??
      quotaFallbackRuntimes.map((runtime) => ({
        exhaustionReason: runtime.descriptor.exhaustionReason,
        disableIncludedAccess: runtime.descriptor.disableIncludedAccess,
        fallbackApiProvider: runtime.descriptor.fallbackApiProvider,
        getEnabled: runtime.getEnabled,
        setEnabled: runtime.setEnabled,
        restoreEnabled: runtime.restoreEnabled,
      }))
    );
  }

  async useOwnApiKey(
    request: ProgressApiKeyRetryRequest,
  ): Promise<ProgressApiKeyRetryResult> {
    if (
      isKimiCodeSubscriptionRetryBlocked(
        request.model,
        request.exhaustionReason,
      )
    ) {
      return noRetryResult();
    }

    const proceeded = await this.ensureOwnApiKey({
      ...request,
      provider: this.credentialProviderFor(request),
    });
    if (
      !proceeded ||
      !this.deps.isRetryPending(request.stream, request.requestId)
    ) {
      return noRetryResult();
    }

    return this.routingCommitQueue.add(async () => {
      // The request may have been dismissed or replaced while this callback
      // waited behind another stream's routing commit. Re-check before touching
      // global routing so a stale switch cannot briefly rebind credentials.
      if (!this.deps.isRetryPending(request.stream, request.requestId)) {
        return noRetryResult();
      }
      const routingBefore = this.routingSnapshot();
      const prepared = await this.applyOwnApiKeyRouting(request, routingBefore);
      let retried = false;
      try {
        retried = await this.deps.triggerRetry(
          request.stream,
          request.requestId,
        );
      } catch (error) {
        await this.restoreAfterError(routingBefore, prepared);
        throw error;
      }
      if (!retried) {
        await this.restoreOwnApiKeyRouting(routingBefore, prepared);
        return noRetryResult();
      }
      return {
        ...prepared,
        retried: true,
      };
    });
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

  // OAuth subscriptions pin the fallback key provider (ChatGPT → openai,
  // Grok → xai) so a mislabeled SDK provider cannot prompt for the wrong key.
  private resolveProvider(
    request: Pick<ProgressApiKeyRetryRequest, 'provider' | 'exhaustionReason'>,
  ): ApiProvider | undefined {
    const route = this.quotaFallbackToggles.find(
      (candidate) => candidate.exhaustionReason === request.exhaustionReason,
    );
    return route?.fallbackApiProvider ?? request.provider;
  }

  private shouldDisableIncludedModelAccess(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    if (request.viaRelay === true) return true;
    if (request.exhaustionReason === 'copilot-subscription') return true;
    return this.matchingQuotaToggles(request).some(
      (toggle) => toggle.disableIncludedAccess,
    );
  }

  /** Whether this toggle should turn off for `request`. Catalog match plus
   *  the two request-specific extras that are not their own exhaustion
   *  reason: Copilot→ChatGPT, and a dual-backend Kimi credit reroute. */
  private shouldDisableToggle(
    toggle: QuotaFallbackToggle,
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    if (request.exhaustionReason === toggle.exhaustionReason) return true;
    if (
      toggle.exhaustionReason === 'chatgpt-subscription' &&
      request.exhaustionReason === 'copilot-subscription' &&
      request.chatGptSubscriptionEligible === true
    ) {
      return true;
    }
    // An `upstream-credit` failure on a dual-backend Kimi model means the
    // broken credential is the `kimiCode` key, but the forwarded SDK
    // provider is `moonshot`. The coding-plan quota reason does not match,
    // so without this branch the "Prefer Kimi Code" switch would stay on
    // and the retry rebuild would re-select the exhausted coding endpoint
    // instead of the newly entered Moonshot key.
    //
    // Deliberately conservative: do not consult the live route resolver
    // here. The failed handler was dispatched under the persisted
    // `ModelHandlerKimi` compatibility key, and the retry rebuild pins that
    // same key, so a later OpenRouter preference change cannot make the
    // rebuild take a non-coding route. The request's
    // `kimiCodeRoutedOnFailure` flag is captured from that failed handler,
    // so unrelated `kimi3` failures through OpenRouter, Moonshot, or the
    // relay leave the preference untouched.
    return (
      toggle.exhaustionReason === 'kimi-code-subscription' &&
      request.exhaustionReason === 'upstream-credit' &&
      request.kimiCodeRoutedOnFailure === true &&
      this.isDualBackendKimiCodeModel(request.model)
    );
  }

  private matchingQuotaToggles(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): readonly QuotaFallbackToggle[] {
    return this.quotaFallbackToggles.filter((toggle) =>
      this.shouldDisableToggle(toggle, request),
    );
  }

  private async applyOwnApiKeyRouting(
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
    before: ProgressApiRoutingSnapshot,
  ): Promise<ProgressApiKeyPreparationResult> {
    // Each attempted switch is registered for compensation before its setter
    // is awaited: a setter can mutate in memory and then reject on
    // persistence, so a throw midway must roll back every switch that may
    // have landed instead of stranding global toggles the retry never uses.
    let disabledIncludedModelAccess = false;
    const disabledQuotaRoutes: ExhaustionReason[] = [];
    try {
      // Disable relay (included access) so the retry uses the user's own key,
      // not the relay JWT, whenever the switch promises "your own API key".
      // Both relay and subscription exhaustion fall through to a direct handler,
      // which otherwise may still prefer included access over the stored key.
      // A direct-key failure leaves relay untouched for other providers.
      if (this.shouldDisableIncludedModelAccess(request)) {
        disabledIncludedModelAccess = true;
        await this.deps.setUseIncludedModelAccess(false);
        this.deps.invalidateModelOptionsCache();
      }

      // One chain: turn off every matching quota-fallback preference so the
      // retry rebuilds onto the fallback credential. Remark: prefer-off
      // sticks after the quota resets — users may forget to re-enable it.
      for (const toggle of this.quotaFallbackToggles) {
        if (toggle.getEnabled() && this.shouldDisableToggle(toggle, request)) {
          disabledQuotaRoutes.push(toggle.exhaustionReason);
          await toggle.setEnabled(false);
          this.deps.invalidateModelOptionsCache();
        }
      }

      return {
        proceeded: true,
        disabledIncludedModelAccess,
        disabledQuotaRoutes,
      };
    } catch (error) {
      await this.restoreAfterError(before, {
        proceeded: true,
        disabledIncludedModelAccess,
        disabledQuotaRoutes,
      });
      throw error;
    }
  }

  /** Apply Copilot fallback routing only for the duration of a launch attempt. */
  async runCopilotFallbackWithRouting(
    request: ProgressApiKeyRetryRequest,
    start: (copilotRouteOverride: CopilotRouteOverride) => Promise<boolean>,
  ): Promise<boolean> {
    return this.routingCommitQueue.add(async () => {
      // Mirror `useOwnApiKey`: this callback may have waited behind another
      // stream's routing commit. Re-check the exact retry identity before
      // touching global routing so a dismissed/replaced request cannot apply
      // a stale switch.
      if (!this.deps.isRetryPending(request.stream, request.requestId)) {
        return false;
      }
      const before = this.routingSnapshot();
      const prepared = await this.applyOwnApiKeyRouting(request, before);
      // The user chose "use own API key" for this retry. The direct-route
      // override travels only with the replacement launch; the standing
      // preference remains visible to concurrent and future runs.
      let started = false;
      try {
        started = await start('direct');
      } catch (error) {
        await this.restoreAfterError(before, prepared);
        throw error;
      }
      if (!started) await this.restoreOwnApiKeyRouting(before, prepared);
      return started;
    });
  }

  private routingSnapshot(): ProgressApiRoutingSnapshot {
    return {
      useIncludedModelAccess: this.deps.getUseIncludedModelAccess(),
      quotaRoutes: new Map(
        this.quotaFallbackToggles.map((toggle) => [
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
    // Roll back in reverse application order: quota-fallback toggles
    // switched last, so they come back first. Every restore is attempted
    // even when an earlier one fails; the first failure rethrows once the
    // rest have run (compensation per the error-handling checklist's L2).
    const restores: Array<() => Promise<void>> = [];
    for (const reason of [...prepared.disabledQuotaRoutes].reverse()) {
      const toggle = this.quotaFallbackToggles.find(
        (candidate) => candidate.exhaustionReason === reason,
      );
      if (toggle)
        restores.push(() =>
          (toggle.restoreEnabled ?? toggle.setEnabled)(
            before.quotaRoutes.get(reason) ?? false,
          ),
        );
    }
    if (prepared.disabledIncludedModelAccess) {
      restores.push(() =>
        this.deps.setUseIncludedModelAccess(before.useIncludedModelAccess),
      );
    }
    let firstFailure: unknown;
    for (const restore of restores) {
      try {
        await restore();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    // Invalidate whenever a rollback was scheduled, even after a restore
    // failure: a setter that mutated in memory before rejecting leaves the
    // cached options describing the wrong routing. A failed invalidation
    // must not replace the restore failure the caller can act on.
    if (restores.length > 0) {
      try {
        this.deps.invalidateModelOptionsCache();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  /**
   * Roll back a routing switch that an in-flight failure already doomed.
   * The toggle restore is best-effort here: its failure must not mask the
   * original error the caller can act on, and the state a failed rollback
   * leaves is the same stranded one an unguarded throw would have left.
   */
  private async restoreAfterError(
    before: ProgressApiRoutingSnapshot,
    prepared: ProgressApiKeyPreparationResult,
  ): Promise<void> {
    await this.restoreOwnApiKeyRouting(before, prepared).catch(() => {});
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
