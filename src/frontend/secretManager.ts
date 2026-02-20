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
   */
  private static async lookupApiKey(
    provider: ApiProvider,
  ): Promise<string | undefined> {
    const secretKey = await this.get(this.getApiKeySecretName(provider));
    return secretKey ?? process.env[`${provider.toUpperCase()}_API_KEY`];
  }

  public static async getApiKey(provider: ApiProvider): Promise<string> {
    const key = await this.lookupApiKey(provider);
    if (key) {
      return key;
    }
    throw new Error(
      `No API key found for ${provider}. Please set it using the "Set API Key" command or ${provider.toUpperCase()}_API_KEY environment variable.`,
    );
  }

  /**
   * Returns the set of secret storage keys that match the `apiKey.*` prefix.
   * Uses `SecretStorage.keys()` (VS Code 1.105+) for a single round-trip
   * instead of probing each provider individually.
   */
  private static async getStoredApiKeyNames(): Promise<Set<string>> {
    const allKeys = await this.storage.keys();
    return new Set(allKeys.filter((k) => k.startsWith('apiKey.')));
  }

  public static async anyApiKeyExists(): Promise<boolean> {
    // Fast check via keys() — one call covers all providers
    const storedKeys = await this.getStoredApiKeyNames();
    if (storedKeys.size > 0) {
      return true;
    }
    // Check environment variables as fallback
    const hasEnvKey = this.API_PROVIDERS.some(
      (provider) =>
        process.env[`${provider.toUpperCase()}_API_KEY`] !== undefined,
    );
    if (hasEnvKey) {
      return true;
    }
    // Fall back to server-side keys (Ultra tier + enabled providers)
    return getServerSideKeyService().canUseServerSideKeys();
  }

  public static async apiKeyExists(provider: ApiProvider): Promise<boolean> {
    const key = await this.lookupApiKey(provider);
    return key !== undefined;
  }

  public static async getApiProviderQuickPickItems(): Promise<
    ApiProviderQuickPickItem[]
  > {
    // Single call to enumerate stored keys, then check env vars only for missing ones
    const storedKeys = await this.getStoredApiKeyNames();

    return this.API_PROVIDERS.map((provider) => {
      const secretName = this.getApiKeySecretName(provider);
      const exists =
        storedKeys.has(secretName) ||
        process.env[`${provider.toUpperCase()}_API_KEY`] !== undefined;
      return {
        label: provider,
        description: exists ? 'key set' : 'not set',
        provider,
      };
    });
  }
}
