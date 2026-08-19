// Local imports - hosts
import type { ExternalOpener, PromptHost } from '@hosts/uiHosts';
// Local imports - model
import { apiKeySecretName, isApiProvider } from '@model/apiProviders';
// Local imports - platform
import { platform } from '@platform/platform';
// Local imports - utilities
import { looksLikeCredentialPlaceholder } from '@utils/text/credentialPlaceholder';

interface SettingsProfileKeyControllerDeps {
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>;
  externalOpener: Pick<ExternalOpener, 'openExternal'>;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  refreshAfterKeyChange(provider: string): Promise<void>;
  /**
   * Show a failed key action to the user. Required: a rejected placeholder or
   * an unknown provider must never fail silently on any host.
   */
  reportFailure(message: string, error: unknown): Promise<void>;
}

/**
 * Canonical "commit/remove a provider key" logic, shared by every surface
 * that lets a user set or remove an API key (settingsView's Profile tab and
 * the main webview's API key banner). Each surface injects its own prompt
 * flow, refresh behavior, and failure presentation; validation, the
 * write/delete/confirm/notify sequence, and the secret-store naming live here
 * once so they can't drift between surfaces.
 */
export class SettingsProfileKeyController {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps) {}

  async setProviderKey(provider: string): Promise<void> {
    await this.run(provider, 'set', async () => {
      const apiKey = await this.deps.prompt.input({
        prompt: `Enter ${this.deps.getProviderDisplayName(provider)} API key`,
        password: true,
        placeHolder: '************************************',
      });
      if (apiKey == null) return false;
      return this.storeProviderKey(provider, apiKey);
    });
  }

  async commitProviderKey(provider: string, apiKey: string): Promise<void> {
    await this.run(provider, 'set', () =>
      this.storeProviderKey(provider, apiKey),
    );
  }

  async removeProviderKey(provider: string): Promise<void> {
    await this.run(provider, 'remove', async () => {
      const displayName = this.deps.getProviderDisplayName(provider);
      const confirmed = await this.deps.prompt.confirm(
        `Remove the ${displayName} API key? This cannot be undone.`,
        { confirmLabel: 'Remove', cancelLabel: 'Cancel', modal: false },
      );
      if (!confirmed) return false;

      await platform().secrets.delete(secretNameFor(provider));
      void this.deps.prompt.info(`${displayName} API key has been removed`);
      return true;
    });
  }

  async openProviderKeyUrl(provider: string): Promise<void> {
    const url = this.deps.getProviderKeyUrl(provider);
    if (url) {
      await this.deps.externalOpener.openExternal(url);
    }
  }

  private async storeProviderKey(
    provider: string,
    apiKey: string,
  ): Promise<boolean> {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return false;

    const displayName = this.deps.getProviderDisplayName(provider);
    if (looksLikeCredentialPlaceholder(normalizedApiKey)) {
      throw new Error(
        `This looks like a placeholder rather than a ${displayName} API key. Enter the key issued by the provider.`,
      );
    }

    await platform().secrets.set(secretNameFor(provider), normalizedApiKey);
    void this.deps.prompt.info(`${displayName} API key has been set`);
    return true;
  }

  private async run(
    provider: string,
    verb: 'set' | 'remove',
    action: () => Promise<boolean>,
  ): Promise<void> {
    let changed: boolean;
    try {
      changed = await action();
    } catch (error) {
      await this.deps.reportFailure(
        `Failed to ${verb} ${this.deps.getProviderDisplayName(provider)} API key`,
        error,
      );
      return;
    }

    if (!changed) return;

    try {
      await this.deps.refreshAfterKeyChange(provider);
    } catch (error) {
      const gerund = verb === 'set' ? 'setting' : 'removing';
      await this.deps.reportFailure(
        `Failed to refresh after ${gerund} ${this.deps.getProviderDisplayName(provider)} API key`,
        error,
      );
    }
  }
}

function secretNameFor(provider: string): string {
  if (!isApiProvider(provider)) {
    throw new Error(`Unknown API provider: ${provider}`);
  }
  return apiKeySecretName(provider);
}
