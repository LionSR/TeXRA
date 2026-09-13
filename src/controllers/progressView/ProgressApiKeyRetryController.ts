import { Effect, Equal, Redacted } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import { hostPort } from '@common/hostPort';
import type { ApiProvider } from '@model/apiProviders';
import { resolveDirectModelApiKeyProvider } from '@model/openRouterRouting';
import type { ExhaustionReason, RunId } from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiCodeSubscriptionRetryBlocked,
} from '@shared/model/kimiCodeRetryGate';
import { quotaFallbackRouteForExhaustion } from '@shared/quotaFallbackRoutes';

interface ProgressApiKeyRetryRequest {
  stream: RunId;
  requestId: string;
  provider?: ApiProvider;
  /** Canonical base model the fallback run will launch with, when known. */
  model?: string;
  exhaustionReason?: ExhaustionReason;
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(
    provider: ApiProvider,
  ): Promise<Redacted.Redacted<string> | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  isRetryPending(stream: RunId, requestId: string): boolean;
  triggerRetry(
    stream: RunId,
    requestId: string,
  ): Effect.Effect<boolean, unknown>;
}

/**
 * Owns the policy for switching from a quota-exhausted subscription route to
 * user-provided keys.
 *
 * The progress view host still owns prompts and messages; this controller keeps
 * the credential/retry rules testable without depending on VS Code APIs.
 */
export class ProgressApiKeyRetryController {
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

    // The decision is the whole switch: the run reads `credentials:
    // 'personal'` off its own ledger and declines the exhausted route for
    // itself when it rebinds. No preference of the user's is rewritten, so
    // two runs falling back at once cannot undo each other's choice.
    yield* this.deps.triggerRetry(request.stream, request.requestId);
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

  // OAuth subscriptions pin the fallback key provider (ChatGPT → openai,
  // Grok → xai) so a mislabeled SDK provider cannot prompt for the wrong key.
  private resolveProvider(
    request: Pick<ProgressApiKeyRetryRequest, 'provider' | 'exhaustionReason'>,
  ): ApiProvider | undefined {
    const route = quotaFallbackRouteForExhaustion(request.exhaustionReason);
    return route?.fallbackApiProvider ?? request.provider;
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
    keysBefore: ReadonlyMap<ApiProvider, Redacted.Redacted<string> | undefined>,
  ): Effect.Effect<boolean, unknown> {
    return Effect.map(this.readKeys(providers), (keysAfter) =>
      providers.some((provider) => {
        const next = keysAfter.get(provider);
        // Sealed values are compared by `Equal`, never unwrapped: this only
        // needs to know whether the credential changed, not what it is.
        return (
          next !== undefined && !Equal.equals(next, keysBefore.get(provider))
        );
      }),
    );
  }

  private readKeys(
    providers: readonly ApiProvider[],
  ): Effect.Effect<
    Map<ApiProvider, Redacted.Redacted<string> | undefined>,
    unknown
  > {
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
