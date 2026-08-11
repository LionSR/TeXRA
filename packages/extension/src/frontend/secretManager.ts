// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  API_PROVIDERS,
  apiKeySecretName,
  hasUsableApiKey as resolvedHasUsableApiKey,
  type ApiProvider,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import type * as vscode from 'vscode';

export type { ApiProvider };

export interface ApiProviderQuickPickItem extends vscode.QuickPickItem {
  provider: ApiProvider;
}

/**
 * VS Code presentation over the one secrets door, `platform().secrets`. Reads
 * and writes go through the platform port so environment overrides apply on
 * every path; only the quick-pick and label helpers live here.
 */
export class SecretManager {
  public static async get(key: string): Promise<string | undefined> {
    return platform().secrets.get(key);
  }

  public static async set(key: string, value: string): Promise<void> {
    await platform().secrets.set(key, value);
  }

  public static async delete(key: string): Promise<void> {
    await platform().secrets.delete(key);
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

  private static async apiKeyExists(provider: ApiProvider): Promise<boolean> {
    return resolvedHasUsableApiKey(platform().secrets, provider);
  }

  /**
   * Same check as the private `apiKeyExists` above (both delegate to
   * `@model/apiProviders`'s `hasUsableApiKey`); exposed publicly under this
   * name for launch-readiness call sites that want the "usable" framing.
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
