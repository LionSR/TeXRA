// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';

export type ApiProvider = (typeof SecretManager.API_PROVIDERS)[number];

export interface ApiProviderQuickPickItem extends vscode.QuickPickItem {
  provider: ApiProvider;
}

export class SecretManager {
  private static secretStorage: vscode.SecretStorage | undefined;

  public static initialize(context: vscode.ExtensionContext): void {
    this.secretStorage = context.secrets;
  }

  private static get storage(): vscode.SecretStorage {
    if (!this.secretStorage) {
      throw new Error('Secret storage not initialized');
    }
    return this.secretStorage;
  }

  public static async get(key: string): Promise<string | undefined> {
    return this.storage.get(key);
  }

  public static async set(key: string, value: string): Promise<void> {
    await this.storage.store(key, value);
  }

  public static async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  public static readonly API_PROVIDERS = [
    'openai',
    'anthropic',
    'openRouter',
    'google',
    'xai',
    'deepseek',
    'moonshot',
    'dashscope',
    'wolframllmapp',
  ] as const;

  public static getApiKeySecretName(provider: ApiProvider): string {
    return `apiKey.${provider}`;
  }

  /**
   * Lookup API key from secret storage or environment variable.
   * Returns the key value if found, undefined otherwise.
   */
  private static async lookupApiKey(
    provider: ApiProvider,
  ): Promise<string | undefined> {
    const secretKey = await this.get(this.getApiKeySecretName(provider));
    if (secretKey) {
      return secretKey;
    }

    const envKey = `${provider.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  public static async getApiKey(provider: ApiProvider): Promise<string> {
    const key = await this.lookupApiKey(provider);
    if (key) {
      return key;
    }

    const envKey = `${provider.toUpperCase()}_API_KEY`;
    throw new Error(
      `No API key found for ${provider}. Please set it using the "Set API Key" command or ${envKey} environment variable.`,
    );
  }

  public static async anyApiKeyExists(): Promise<boolean> {
    // Check local API keys first
    for (const provider of this.API_PROVIDERS) {
      if (await this.apiKeyExists(provider)) {
        return true;
      }
    }

    // Check if server-side keys are available (Ultra tier + enabled providers)
    // This returns true if user has Ultra tier and at least one provider is enabled
    return getServerSideKeyService().canUseServerSideKeys();
  }

  public static async apiKeyExists(provider: ApiProvider): Promise<boolean> {
    return (await this.lookupApiKey(provider)) !== undefined;
  }

  public static async getApiProviderQuickPickItems(): Promise<
    ApiProviderQuickPickItem[]
  > {
    const checks = this.API_PROVIDERS.map(async (provider) => ({
      provider,
      exists: await this.apiKeyExists(provider),
    }));

    const results = await Promise.all(checks);
    return results.map(({ provider, exists }) => ({
      label: provider,
      description: exists ? 'key set' : 'not set',
      provider,
    }));
  }
}
