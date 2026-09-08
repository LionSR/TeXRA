// Local imports
import {
  API_PROVIDERS,
  hasUsableApiKey as resolvedHasUsableApiKey,
  type ApiProvider,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';
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
 * VS Code presentation over the one secrets door, `PlatformSecrets`.
 *
 * Secret reads and writes go through the port directly at call sites
 * (`secrets.get/set/delete`) so environment overrides apply on every path;
 * this module holds only the VS Code presentation helpers that compose that
 * port: the API-provider quick-pick and the canonical label/key constants
 * re-exported from their owning modules.
 */
export class SecretManager {
  public static readonly API_PROVIDERS = API_PROVIDERS;

  public static readonly GITHUB_TOKEN_KEY = GITHUB_TOKEN_STORAGE_KEY;

  public static gitHubTokenExists(): Promise<'secret' | 'env' | 'none'> {
    return resolveGitHubTokenSource(platform().secrets);
  }

  public static getApiProviderQuickPickItems(
    secrets: PlatformSecrets,
  ): Promise<ApiProviderQuickPickItem[]> {
    return Promise.all(
      this.API_PROVIDERS.map(async (provider) => ({
        label: provider,
        description: (await resolvedHasUsableApiKey(secrets, provider))
          ? 'key set'
          : 'not set',
        provider,
      })),
    );
  }
}
