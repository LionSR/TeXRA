// Third-party imports
import * as vscode from 'vscode';

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

  public static async getApiKey(provider: ApiProvider): Promise<string> {
    const secretKey = await this.get(this.getApiKeySecretName(provider));
    if (secretKey) {
      return secretKey;
    }

    const envKey = `${provider.toUpperCase()}_API_KEY`;
    const envValue = process.env[envKey];
    if (!envValue) {
      throw new Error(
        `No API key found for ${provider}. Please set it using the "Set API Key" command or ${envKey} environment variable.`,
      );
    }

    return envValue;
  }

  public static async anyApiKeyExists(): Promise<boolean> {
    for (const provider of this.API_PROVIDERS) {
      if (await this.apiKeyExists(provider)) {
        return true;
      }
    }
    return false;
  }

  public static async apiKeyExists(provider: ApiProvider): Promise<boolean> {
    const secretKey = await this.get(this.getApiKeySecretName(provider));
    if (secretKey) {
      return true;
    }

    const envKey = `${provider.toUpperCase()}_API_KEY`;
    return Boolean(process.env[envKey]);
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
