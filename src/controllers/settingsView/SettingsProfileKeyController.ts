// Local imports - hosts
import type { ExternalOpener } from '@hosts/externalOpener';
import type { PromptHost } from '@hosts/promptHost';

export interface SettingsProfileKeyControllerDeps {
  prompt: Pick<PromptHost, 'input' | 'info'>;
  externalOpener: Pick<ExternalOpener, 'openExternal'>;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  getApiKeySecretName(provider: string): string;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  refreshAfterKeyChange(): Promise<void>;
}

export class SettingsProfileKeyController {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps) {}

  getProviderDisplayName(provider: string): string {
    return this.deps.getProviderDisplayName(provider);
  }

  async setProviderKey(provider: string): Promise<void> {
    const displayName = this.getProviderDisplayName(provider);
    const apiKey = await this.deps.prompt.input({
      prompt: `Enter ${displayName} API key`,
      password: true,
      placeHolder: '************************************',
    });

    if (!apiKey) return;

    await this.deps.setSecret(this.deps.getApiKeySecretName(provider), apiKey);
    void this.deps.prompt.info(`${displayName} API key has been set`);
    await this.deps.refreshAfterKeyChange();
  }

  async removeProviderKey(provider: string): Promise<void> {
    const displayName = this.getProviderDisplayName(provider);
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
