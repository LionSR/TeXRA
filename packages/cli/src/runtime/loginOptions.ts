import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider, type OAuthProvider } from '@auth/sharedConfig';
import { isNonEmptyString } from '@utils/core/stringCore';

import { CLI_OAUTH_PROVIDER_INPUTS } from './oauthProviderDisplay';

export interface CliLoginInit {
  readonly provider: string;
  readonly providerExplicit: boolean;
  readonly noBrowser: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

export interface CliLoginSlashArgs {
  readonly provider: OAuthProvider;
  readonly noBrowser: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

export function resolveLoginProvider(
  positional: string | undefined,
  flag: string | undefined,
): { readonly provider: string; readonly explicit: boolean } {
  if (isNonEmptyString(flag)) {
    return { provider: flag.trim(), explicit: true };
  }
  if (isNonEmptyString(positional)) {
    return { provider: positional.trim(), explicit: true };
  }
  return { provider: DEFAULT_OAUTH_PROVIDER, explicit: false };
}

export function unsupportedLoginProviderMessage(provider: string): string {
  return `Unsupported provider: ${provider}. Expected ${CLI_OAUTH_PROVIDER_INPUTS}.`;
}

export function isCliLoginProvider(
  provider: string,
): provider is OAuthProvider {
  return isOAuthProvider(provider);
}

export function githubSelectAccountWarning(
  init: Pick<CliLoginInit, 'provider' | 'selectAccount' | 'loginHint'>,
): string | undefined {
  return init.provider === 'github' && init.selectAccount && !init.loginHint
    ? 'GitHub does not support --select-account by itself. Use --login-hint <username> to request a specific GitHub account.'
    : undefined;
}

export function parseChatLoginSlashArgs(
  input: string,
): CliLoginSlashArgs | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let provider: string = DEFAULT_OAUTH_PROVIDER;
  let providerSet = false;
  let noBrowser = false;
  let selectAccount = false;
  let loginHint: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (token === '--select-account') {
      selectAccount = true;
      continue;
    }
    if (token === '--login-hint') {
      const next = tokens[index + 1];
      if (!next || next.startsWith('--')) return undefined;
      loginHint = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--login-hint=')) {
      const value = token.slice('--login-hint='.length).trim();
      if (!value || value.startsWith('--')) return undefined;
      loginHint = value;
      continue;
    }
    if (token.startsWith('--') || providerSet) return undefined;
    provider = token;
    providerSet = true;
  }

  if (!isCliLoginProvider(provider)) return undefined;
  return { provider, noBrowser, selectAccount, loginHint };
}
