import {
  OAUTH_PROVIDER_LABELS,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '@auth/config';

export interface CliOAuthProviderItem {
  readonly value: OAuthProvider;
  readonly label: string;
}

export const CLI_OAUTH_PROVIDER_INPUTS = OAUTH_PROVIDERS.join(' or ');

export const CLI_OAUTH_PROVIDER_ITEMS: readonly CliOAuthProviderItem[] =
  OAUTH_PROVIDERS.map((provider) => ({
    value: provider,
    label: OAUTH_PROVIDER_LABELS[provider],
  }));
