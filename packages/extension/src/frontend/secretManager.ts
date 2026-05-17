// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';

export type { ApiProvider };

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

  public static readonly API_PROVIDERS = API_PROVIDERS;

  public static readonly GITHUB_TOKEN_KEY = 'github.token';

  public static getApiKeySecretName(provider: ApiProvider): string {
    return `apiKey.${provider}`;
  }

  /** Read the GitHub personal access token from secret storage, env fallback. */
  public static async getGitHubToken(): Promise<string | undefined> {
    const stored = await this.get(this.GITHUB_TOKEN_KEY);
    return stored ?? process.env.GITHUB_TOKEN ?? undefined;
  }

  public static async gitHubTokenExists(): Promise<'secret' | 'env' | 'none'> {
    const stored = await this.get(this.GITHUB_TOKEN_KEY);
    if (stored) return 'secret';
    if (process.env.GITHUB_TOKEN) return 'env';
    return 'none';
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

  /**
   * Like `apiKeyExists` but rejects empty / whitespace-only values. A
   * stale `PROVIDER_API_KEY=""` env var is "present" but not usable at
   * launch — every runtime auth path falls over on a blank key. Callers
   * that gate on "can this credential actually authenticate?" (the
   * setup flow, per-provider probes, preflight checks) must use this
   * helper rather than the looser `apiKeyExists`.
   */
  public static async hasUsableApiKey(provider: ApiProvider): Promise<boolean> {
    const key = await this.lookupApiKey(provider);
    return typeof key === 'string' && key.trim().length > 0;
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
