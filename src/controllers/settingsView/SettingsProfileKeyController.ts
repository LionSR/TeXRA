// Local imports - hosts
import type { ExternalOpener, PromptHost } from '@hosts/uiHosts';

export interface SettingsProfileKeyControllerDeps {
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>;
  externalOpener: Pick<ExternalOpener, 'openExternal'>;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  getApiKeySecretName(provider: string): string;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  refreshAfterKeyChange(): Promise<void>;
}

/**
 * Canonical "commit/remove a provider key" logic, shared by every surface
 * that lets a user set or remove an API key (settingsView's Profile tab and
 * the main webview's API key banner). Each surface injects its own prompt
 * flow and refresh behavior; the write/delete/confirm/notify sequence lives
 * here once so it can't drift between surfaces.
 */
export class SettingsProfileKeyController {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps) {}

  async setProviderKey(provider: string): Promise<void> {
    const displayName = this.deps.getProviderDisplayName(provider);
    const apiKey = await this.deps.prompt.input({
      prompt: `Enter ${displayName} API key`,
      password: true,
      placeHolder: '************************************',
    });

    if (!apiKey) return;

    await this.commitProviderKey(provider, apiKey);
  }

  async commitProviderKey(provider: string, apiKey: string): Promise<void> {
    if (!apiKey) return;

    const displayName = this.deps.getProviderDisplayName(provider);
    await this.deps.setSecret(this.deps.getApiKeySecretName(provider), apiKey);
    void this.deps.prompt.info(`${displayName} API key has been set`);
    await this.deps.refreshAfterKeyChange();
  }

  async removeProviderKey(provider: string): Promise<void> {
    const displayName = this.deps.getProviderDisplayName(provider);
    const confirmed = await this.deps.prompt.confirm(
      `Remove the ${displayName} API key? This cannot be undone.`,
      { confirmLabel: 'Remove', cancelLabel: 'Cancel', modal: false },
    );
    if (!confirmed) return;

    await this.deps.deleteSecret(this.deps.getApiKeySecretName(provider));
    void this.deps.prompt.info(`${displayName} API key has been removed`);
    await this.deps.refreshAfterKeyChange();
  }

  async openProviderKeyUrl(provider: string): Promise<void> {
    const url = this.deps.getProviderKeyUrl(provider);
    if (url) {
      await this.deps.externalOpener.openExternal(url);
    }
  }
}
