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
 * VS Code presentation over the one secrets door, `platform().secrets`.
 *
 * Secret reads and writes go through the platform port directly at call sites
 * (`platform().secrets.get/set/delete`) so environment overrides apply on
 * every path; this module holds only the VS Code presentation helpers that
 * compose that port: the API-provider quick-pick, the usable-key checks, and
 * the canonical label/key constants re-exported from their owning modules.
 */
export class SecretManager {
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
      this.API_PROVIDERS.map((provider) => this.hasUsableApiKey(provider)),
    );
    return (
      keyChecks.some(Boolean) ||
      getServerSideKeyService().canUseServerSideKeys()
    );
  }

  /** Usable-key check, delegated to `@model/apiProviders`'s `hasUsableApiKey`. */
  public static async hasUsableApiKey(provider: ApiProvider): Promise<boolean> {
    return resolvedHasUsableApiKey(platform().secrets, provider);
  }

  public static async getApiProviderQuickPickItems(): Promise<
    ApiProviderQuickPickItem[]
  > {
    return Promise.all(
      this.API_PROVIDERS.map(async (provider) => ({
        label: provider,
        description: (await this.hasUsableApiKey(provider))
          ? 'key set'
          : 'not set',
        provider,
      })),
    );
  }
}
