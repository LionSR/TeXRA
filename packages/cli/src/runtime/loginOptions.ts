import {
  DEFAULT_OAUTH_PROVIDER,
  isOAuthProvider,
  type OAuthProvider,
} from '@auth/config';

import { CLI_OAUTH_PROVIDER_INPUTS } from './oauthProviderDisplay';

export interface CliLoginInit {
  readonly provider: string;
  readonly providerExplicit: boolean;
  readonly noBrowser: boolean;
  readonly device: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

export interface CliTexraLoginSlashArgs {
  readonly target: 'texra';
  readonly provider: OAuthProvider;
  readonly noBrowser: boolean;
  readonly device: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

interface CliChatGptLoginSlashArgs {
  readonly target: 'chatgpt';
  readonly noBrowser: boolean;
  readonly device: boolean;
}

interface CliGrokLoginSlashArgs {
  readonly target: 'grok';
  readonly noBrowser: boolean;
  readonly device: boolean;
}

export type CliLoginSlashArgs =
  CliTexraLoginSlashArgs | CliChatGptLoginSlashArgs | CliGrokLoginSlashArgs;

export type CliLogoutTarget = 'chatgpt' | 'grok' | 'texra' | 'all';

const CHATGPT_LOGIN_TARGETS = new Set(['chatgpt', 'codex', 'subscription']);
const GROK_LOGIN_TARGETS = new Set(['grok', 'xai', 'supergrok']);

export function parseCliLogoutTarget(
  input: string,
): CliLogoutTarget | undefined {
  const normalized = input.trim().toLowerCase();
  if (CHATGPT_LOGIN_TARGETS.has(normalized)) return 'chatgpt';
  if (GROK_LOGIN_TARGETS.has(normalized)) return 'grok';
  switch (normalized) {
    case 'texra':
    case 'researcher':
      return 'texra';
    case 'all':
      return 'all';
    default:
      return undefined;
  }
}

export function unsupportedLoginProviderMessage(provider: string): string {
  return `Unsupported provider: ${provider}. Expected ${CLI_OAUTH_PROVIDER_INPUTS}.`;
}

// `--device` and `--no-browser` are distinct sign-in transports, not
// refinements of each other (device-code shows no loopback URL), and the
// device branch silently wins when both are set. Both the CLI command and the
// chat `/login` path reject the combination so the choice is explicit instead
// of quietly ignored.
export const LOGIN_TRANSPORT_CONFLICT_MESSAGE =
  'Use either --device or --no-browser, not both: --device signs in with a one-time code (no loopback URL), while --no-browser prints the loopback sign-in URL.';

export function hasLoginTransportConflict(
  args: Pick<CliLoginInit, 'device' | 'noBrowser'>,
): boolean {
  return args.device && args.noBrowser;
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
  const positionals: string[] = [];
  let noBrowser = false;
  let device = false;
  let selectAccount = false;
  let loginHint: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (token === '--device') {
      device = true;
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
    if (token.startsWith('--')) return undefined;
    positionals.push(token);
  }

  let target: CliLoginSlashArgs['target'] = 'texra';
  if (positionals[0] === 'texra') {
    positionals.shift();
  } else if (positionals[0] && CHATGPT_LOGIN_TARGETS.has(positionals[0])) {
    target = 'chatgpt';
    positionals.shift();
  } else if (positionals[0] && GROK_LOGIN_TARGETS.has(positionals[0])) {
    target = 'grok';
    positionals.shift();
  }

  if (target === 'chatgpt' || target === 'grok') {
    if (positionals.length > 0 || selectAccount || loginHint !== undefined) {
      return undefined;
    }
    return { target, noBrowser, device };
  }

  if (positionals.length > 1) return undefined;
  const provider = positionals[0] ?? DEFAULT_OAUTH_PROVIDER;
  if (!isOAuthProvider(provider)) return undefined;
  return { target, provider, noBrowser, device, selectAccount, loginHint };
}
