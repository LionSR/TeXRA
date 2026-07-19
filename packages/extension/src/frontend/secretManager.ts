// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  API_PROVIDERS,
  apiKeyExists as resolvedApiKeyExists,
  apiKeySecretName,
  hasUsableApiKey as resolvedHasUsableApiKey,
  type ApiProvider,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

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

  public static readonly GITHUB_TOKEN_KEY = GITHUB_TOKEN_STORAGE_KEY;

  public static getApiKeySecretName(provider: ApiProvider): string {
    return apiKeySecretName(provider);
  }

  public static async gitHubTokenExists(): Promise<'secret' | 'env' | 'none'> {
    return resolveGitHubTokenSource(platform().secrets);
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
    return resolvedApiKeyExists(platform().secrets, provider);
  }

  /**
   * Like `apiKeyExists` but also rejects whitespace-only values from any
   * resolved credential. The canonical resolver already treats empty env vars
   * as missing; this helper is for launch checks that need an actually usable
   * authentication value.
   */
  public static async hasUsableApiKey(provider: ApiProvider): Promise<boolean> {
    return resolvedHasUsableApiKey(platform().secrets, provider);
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
