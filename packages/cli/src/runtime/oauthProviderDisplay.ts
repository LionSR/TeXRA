import { OAUTH_PROVIDERS, type OAuthProvider } from '@auth/config';

export interface CliOAuthProviderItem {
  readonly value: OAuthProvider;
  readonly label: string;
}

const CLI_OAUTH_PROVIDER_LABELS = {
  github: 'GitHub',
  google: 'Google',
} satisfies Record<OAuthProvider, string>;

export const CLI_OAUTH_PROVIDER_INPUTS = OAUTH_PROVIDERS.join(' or ');

export const CLI_OAUTH_PROVIDER_ITEMS: readonly CliOAuthProviderItem[] =
  OAUTH_PROVIDERS.map((provider) => ({
    value: provider,
    label: CLI_OAUTH_PROVIDER_LABELS[provider],
  }));
