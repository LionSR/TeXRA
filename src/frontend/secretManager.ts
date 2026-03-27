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
    'minimax',
    'glm',
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
    if (!key) {
      throw new Error(
        `No API key found for ${provider}. Please set it using the "Set API Key" command or ${provider.toUpperCase()}_API_KEY environment variable.`,
      );
    }
    return key;
  }

  public static async anyApiKeyExists(): Promise<boolean> {
    const keyChecks = await Promise.all(
      this.API_PROVIDERS.map((provider) => this.apiKeyExists(provider)),
    );
    return (
      keyChecks.some(Boolean) ||
      getServerSideKeyService().canUseServerSideKeys()
    );
  }

  public static async apiKeyExists(provider: ApiProvider): Promise<boolean> {
    const key = await this.lookupApiKey(provider);
    return key !== undefined;
  }

  public static async getApiProviderQuickPickItems(): Promise<
    ApiProviderQuickPickItem[]
  > {
    return Promise.all(
      this.API_PROVIDERS.map(async (provider) => ({
        label: provider,
        description: (await this.apiKeyExists(provider))
          ? 'key set'
          : 'not set',
        provider,
      })),
    );
  }
}
