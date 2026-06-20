// Local imports - model
import type { ApiProvider } from '@model/apiProviders';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

export interface ProgressApiKeyRetryRequest {
  stream: StreamTabId;
  provider?: ApiProvider;
  upstreamCreditDepleted?: boolean;
  viaRelay?: boolean;
}

export interface ProgressApiKeyRetryResult {
  proceeded: boolean;
  retried: boolean;
  disabledIncludedModelAccess: boolean;
}

export interface ProgressApiKeyRetryControllerDeps {
  providers: readonly ApiProvider[];
  readKey(provider: ApiProvider): Promise<string | undefined>;
  hasUsableKey(provider: ApiProvider): Promise<boolean>;
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  setUseIncludedModelAccess(enabled: boolean): Promise<void>;
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
    const before = requireChange
      ? await this.readKeys(providersToCheck)
      : undefined;

    await this.deps.promptForApiKey(request.provider);

    const shouldProceed = requireChange
      ? await this.hasChangedUsableKey(providersToCheck, before)
      : await this.hasAnyUsableKey(providersToCheck);

    if (!shouldProceed) {
      return {
        proceeded: false,
        retried: false,
        disabledIncludedModelAccess: false,
      };
    }

    let disabledIncludedModelAccess = false;
    if (request.viaRelay === true) {
      await this.deps.setUseIncludedModelAccess(false);
      this.deps.invalidateModelOptionsCache();
      disabledIncludedModelAccess = true;
    }

    return {
      proceeded: true,
      retried: this.deps.triggerRetry(request.stream),
      disabledIncludedModelAccess,
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
    before: ReadonlyMap<ApiProvider, string | undefined> | undefined,
  ): Promise<boolean> {
    const after = await this.readKeys(providers);
    return providers.some((provider) => {
      const next = after.get(provider);
      return (
        typeof next === 'string' &&
        next.trim().length > 0 &&
        next !== before?.get(provider)
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
