import { Effect, Exit, Semaphore } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import { hostPort } from '@controllers/effectPort';
import { createLog } from '@logger/logUtils';
import type { ApiProvider } from '@model/apiProviders';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { resolveDirectModelApiKeyProvider } from '@model/openRouterRouting';
import {
  quotaFallbackRuntimes,
  type QuotaFallbackRuntime,
} from '@model/quotaFallbackRoutes';
import type { ExhaustionReason, StreamTabId } from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiCodeSubscriptionRetryBlocked,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import { isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('ProgressApiKeyRetryController');

interface ProgressApiKeyRetryRequest {
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
}

interface ProgressApiRoutingSnapshot {
  readonly quotaRoutes: ReadonlyMap<ExhaustionReason, boolean>;
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(provider: ApiProvider): Promise<string | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  /** Quota-fallback routes (ChatGPT, Grok, GLM, Kimi). Defaults to the
   *  shared runtime catalog. Tests inject a local table. */
  quotaFallbackRuntimes?: readonly QuotaFallbackRuntime[];
  isRetryPending(stream: StreamTabId, requestId: string): boolean;
  triggerRetry(
    stream: StreamTabId,
    requestId: string,
  ): boolean | Promise<boolean>;
}

/**
 * Owns the policy for switching from a quota-exhausted subscription route to
 * user-provided keys.
 *
 * The progress view host still owns prompts and messages; this controller keeps
 * the credential/retry rules testable without depending on VS Code APIs.
 */
export class ProgressApiKeyRetryController {
  /** One permit: a routing commit holds it from its pending re-check through
   *  the retry launch, so two streams cannot interleave their switches. */
  private readonly routingLane = Semaphore.makeUnsafe(1);

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

  private get fallbackRuntimes(): readonly QuotaFallbackRuntime[] {
    return this.deps.quotaFallbackRuntimes ?? quotaFallbackRuntimes;
  }

  /** Switch this retry onto the user's own key and relaunch it. The host
   *  arm that took the request runs this where it stands. */
  readonly useOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.useOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    request: ProgressApiKeyRetryRequest,
  ) {
    if (
      isKimiCodeSubscriptionRetryBlocked(
        request.model,
        request.exhaustionReason,
      )
    ) {
      return;
    }

    const proceeded = yield* this.ensureOwnApiKey({
      ...request,
      provider: this.credentialProviderFor(request),
    });
    if (
      !proceeded ||
      !this.deps.isRetryPending(request.stream, request.requestId)
    ) {
      return;
    }

    yield* this.commitOwnApiKeyRouting(request, () =>
      this.deps.triggerRetry(request.stream, request.requestId),
    );
  });

  /** Whether the user has (or has just entered) a usable key for this
   *  retry's credential owner. */
  readonly ensureOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.ensureOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ) {
    const provider = this.resolveProvider(request);
    const providersToCheck = provider ? [provider] : this.deps.providers;
    const requireChange = request.exhaustionReason === 'upstream-credit';

    // The gate depends on which credential failed:
    // - Upstream credit depletion means the stored direct key is the broken
    //   credential, so the user must provide a changed usable key.
    // - Subscription quota limits do not imply a broken direct key, so any
    //   usable direct key is enough consent to retry on it.
    if (requireChange) {
      const before = yield* this.readKeys(providersToCheck);
      yield* hostPort(() => this.deps.promptForApiKey(provider));
      return yield* this.hasChangedUsableKey(providersToCheck, before);
    }

    // Subscription exhaustion does not break the stored direct key, so
    // if a usable one already exists, switch to it and retry without
    // re-prompting, since the user has already provided a key. Only prompt when
    // none exists yet, and only re-check the keys after that prompt (so the
    // common already-set path reads the secret store once, not twice).
    if (yield* this.hasAnyUsableKey(providersToCheck)) return true;
    yield* hostPort(() => this.deps.promptForApiKey(provider));
    return yield* this.hasAnyUsableKey(providersToCheck);
  });

  /**
   * Serialize one own-API-key routing commit: switch the routing for `action`
   * and restore it when `action` fails or reports it never used the
   * switches. Returns whether the action used the routing, or false without
   * running the action when the retry identity is no longer pending.
   *
   * The request may have been dismissed or replaced while this callback
   * waited behind another stream's routing commit. The pending identity is
   * re-checked once inside the lane, before touching global routing, so a
   * stale switch cannot briefly rebind credentials.
   */
  private commitOwnApiKeyRouting(
    request: ProgressApiKeyRetryRequest,
    action: () => boolean | PromiseLike<boolean>,
  ): Effect.Effect<boolean, unknown> {
    return this.routingLane.withPermit(
      Effect.scoped(this.routingTransaction(request, action)),
    );
  }

  private readonly routingTransaction = Effect.fn(
    'ProgressApiKeyRetryController.commitOwnApiKeyRouting',
  )(function* (
    this: ProgressApiKeyRetryController,
    request: ProgressApiKeyRetryRequest,
    action: () => boolean | PromiseLike<boolean>,
  ) {
    if (!this.deps.isRetryPending(request.stream, request.requestId)) {
      return false;
    }
    const before = this.routingSnapshot();
    // One chain: turn off every matching quota-fallback preference so the
    // retry rebuilds onto the fallback credential. Remark: prefer-off sticks
    // after the quota resets — users may forget to re-enable it.
    for (const runtime of this.fallbackRuntimes) {
      if (
        !runtime.getEnabled() ||
        !this.shouldDisableRuntime(runtime, request)
      ) {
        continue;
      }
      const reason = runtime.descriptor.exhaustionReason;
      // The compensation is registered before its setter runs: a setter can
      // mutate in memory and then reject on persistence, so a throw midway
      // must roll back every switch that may have landed instead of
      // stranding global toggles the retry never uses. Finalizers run last
      // registered first, so the rollback is in reverse application order
      // and every restore is attempted. A restore that fails is logged here,
      // where the rollback is owned, then dies: when a switch or the action
      // failed, the caller sees that failure and the restore's defect stays
      // behind it in the Cause; when the action reported no retry, the first
      // restore to fail (the last switch applied) reaches the caller as its
      // own error.
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit) && exit.value === true
          ? Effect.void
          : hostPort(() =>
              runtime.restoreEnabled(before.quotaRoutes.get(reason) ?? false),
            ).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  log.warn(
                    `Failed to restore the ${reason} quota-fallback preference after the retry did not use it: ${toErrorMessage(error)}`,
                  );
                }),
              ),
              Effect.orDie,
            ),
      );
      yield* hostPort(() => runtime.setEnabled(false));
    }

    return yield* hostPort(action);
  });

  // OAuth subscriptions pin the fallback key provider (ChatGPT → openai,
  // Grok → xai) so a mislabeled SDK provider cannot prompt for the wrong key.
  private resolveProvider(
    request: Pick<ProgressApiKeyRetryRequest, 'provider' | 'exhaustionReason'>,
  ): ApiProvider | undefined {
    const route = this.fallbackRuntimes.find(
      (candidate) =>
        candidate.descriptor.exhaustionReason === request.exhaustionReason,
    );
    return route?.descriptor.fallbackApiProvider ?? request.provider;
  }

  /** Whether this route should turn off for `request`. Catalog match plus
   *  the two request-specific extras that are not their own exhaustion
   *  reason: Copilot→ChatGPT, and a dual-backend Kimi credit reroute. */
  private shouldDisableRuntime(
    runtime: QuotaFallbackRuntime,
    request: Omit<ProgressApiKeyRetryRequest, 'stream' | 'requestId'>,
  ): boolean {
    if (request.exhaustionReason === runtime.descriptor.exhaustionReason) {
      return true;
    }
    if (
      runtime.descriptor.exhaustionReason === 'chatgpt-subscription' &&
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
    // so unrelated `kimi3` failures through OpenRouter or Moonshot leave
    // the preference untouched.
    return (
      runtime.descriptor.exhaustionReason === 'kimi-code-subscription' &&
      request.exhaustionReason === 'upstream-credit' &&
      request.kimiCodeRoutedOnFailure === true &&
      this.isDualBackendKimiCodeModel(request.model)
    );
  }

  /** Apply Copilot fallback routing only for the duration of a launch attempt. */
  runCopilotFallbackWithRouting(
    request: ProgressApiKeyRetryRequest,
    start: (copilotRouteOverride: CopilotRouteOverride) => Promise<boolean>,
  ): Effect.Effect<boolean, unknown> {
    // The user chose "use own API key" for this retry. The direct-route
    // override travels only with the replacement launch; the standing
    // preference remains visible to concurrent and future runs.
    return this.commitOwnApiKeyRouting(request, () => start('direct'));
  }

  private routingSnapshot(): ProgressApiRoutingSnapshot {
    return {
      quotaRoutes: new Map(
        this.fallbackRuntimes.map((runtime) => [
          runtime.descriptor.exhaustionReason,
          runtime.getEnabled(),
        ]),
      ),
    };
  }

  private hasAnyUsableKey(
    providers: readonly ApiProvider[],
  ): Effect.Effect<boolean, unknown> {
    return Effect.map(
      Effect.forEach(
        providers,
        (provider) => hostPort(() => this.deps.hasUsableKey(provider)),
        { concurrency: 'unbounded' },
      ),
      (checks) => checks.some(Boolean),
    );
  }

  private hasChangedUsableKey(
    providers: readonly ApiProvider[],
    keysBefore: ReadonlyMap<ApiProvider, string | undefined>,
  ): Effect.Effect<boolean, unknown> {
    return Effect.map(this.readKeys(providers), (keysAfter) =>
      providers.some((provider) => {
        const next = keysAfter.get(provider);
        return isNonEmptyString(next) && next !== keysBefore.get(provider);
      }),
    );
  }

  private readKeys(
    providers: readonly ApiProvider[],
  ): Effect.Effect<Map<ApiProvider, string | undefined>, unknown> {
    return Effect.map(
      Effect.forEach(
        providers,
        (provider) =>
          Effect.map(
            hostPort(() => this.deps.readKey(provider)),
            (key) => [provider, key] as const,
          ),
        { concurrency: 'unbounded' },
      ),
      (entries) => new Map(entries),
    );
  }
}
