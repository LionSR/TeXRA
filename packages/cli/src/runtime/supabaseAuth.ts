// Local imports - auth
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { createHostAuthCoordinator } from '@auth/createHostAuthCoordinator';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  type SupabaseSession,
  type SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { type OAuthProvider } from '@auth/sharedConfig';
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - CLI runtime
import { getCliSecrets } from './cliSecrets';
import { openBrowser } from './supabaseAuthBrowser';
import { startLoopbackCallbackServer } from './supabaseAuthCallbackServer';

// Type imports - platform
import type { LogBackend } from '@platform/interfaces/log';

export interface CliAuthProfile {
  authenticated: boolean;
  accountLabel?: string;
  tier?: string;
  expiresAt?: string;
}

export interface CliLoginOptions {
  provider?: OAuthProvider;
  openBrowser?: boolean;
  selectAccount?: boolean;
  loginHint?: string;
  log?: LogBackend;
  onAuthUrl?: (url: string) => void;
  manualBrowserHint?: string;
}

let coordinator: SupabaseSessionCoordinator | undefined;
let activeAuthLog: LogBackend | undefined;
const deferredAuthLog: LogBackend = {
  initialize: (channel, isAgent) => activeAuthLog?.initialize(channel, isAgent),
  debug: (channel, message) => activeAuthLog?.debug(channel, message),
  info: (channel, message) => activeAuthLog?.info(channel, message),
  warn: (channel, message) => activeAuthLog?.warn(channel, message),
  error: (channel, message) => activeAuthLog?.error(channel, message),
};
const cliAuthProvider = {
  isAuthenticated: () => SupabaseClient.isAuthenticated(),
  getUserTier: () => SupabaseClient.getUserTier(),
  getAccessToken: () => SupabaseClient.getAccessToken(),
};

function getCliSupabaseAuthCoordinator(): SupabaseSessionCoordinator {
  initializeCliSupabaseAuth();
  return coordinator!;
}

export function initializeCliSupabaseAuth(log?: LogBackend): void {
  activeAuthLog = log ?? activeAuthLog;
  coordinator ??= createHostAuthCoordinator({
    secrets: getCliSecrets(),
    log: deferredAuthLog,
  });
}

export function getCliAuthProvider() {
  return cliAuthProvider;
}

export async function signInCliSupabase(
  options: CliLoginOptions = {},
): Promise<SupabaseSession> {
  const provider = options.provider ?? DEFAULT_OAUTH_PROVIDER;
  const authCoordinator = getCliSupabaseAuthCoordinator();
  const callbackServer = await startLoopbackCallbackServer(authCoordinator);
  const redirectTo = callbackServer.redirectTo;
  const queryParams = buildOAuthQueryParams(provider, options);

  try {
    if (options.selectAccount || options.loginHint) {
      await authCoordinator.clearSession();
    }
    const { data, error } =
      await SupabaseClient.getClient().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          ...(queryParams && { queryParams }),
        },
      });
    if (error || !data.url) {
      throw new Error(
        `OAuth initialization failed: ${error?.message || 'missing auth URL'}`,
      );
    }

    options.onAuthUrl?.(data.url);
    if (options.openBrowser ?? true) {
      await openBrowser(
        data.url,
        options.log,
        options.manualBrowserHint ?? 'texra login --no-browser',
      );
    }

    const session = await callbackServer.waitForSession();
    getServerSideKeyService().clearAllCaches({ resetQuotaFlip: true });
    await getServerSideKeyService().setUseIncludedModelAccess(true);
    return session;
  } finally {
    await callbackServer.close();
  }
}

function buildOAuthQueryParams(
  provider: OAuthProvider,
  options: Pick<CliLoginOptions, 'selectAccount' | 'loginHint'>,
): Record<string, string> | undefined {
  const queryParams: Record<string, string> = {};
  if (options.loginHint) {
    queryParams[provider === 'github' ? 'login' : 'login_hint'] =
      options.loginHint;
  }
  if (options.selectAccount && provider === 'google') {
    queryParams.prompt = 'select_account';
  }
  return Object.keys(queryParams).length > 0 ? queryParams : undefined;
}

export async function signOutCliSupabase(): Promise<void> {
  const authCoordinator = getCliSupabaseAuthCoordinator();
  await authCoordinator.clearSession();
  const serverSideKeyService = getServerSideKeyService();
  await serverSideKeyService.setUseIncludedModelAccess(false);
  serverSideKeyService.clearAllCaches({ resetQuotaFlip: true });
}

export async function getCliAuthProfile(): Promise<CliAuthProfile> {
  initializeCliSupabaseAuth();
  const authenticated = await SupabaseClient.isAuthenticated();
  if (!authenticated) return { authenticated: false };

  const session = await getCliSupabaseAuthCoordinator().loadSession();
  let tier = 'free';
  try {
    tier = await SupabaseClient.getUserTier();
  } catch {
    // Keep status usable even if profile metadata is temporarily unavailable.
  }
  return {
    authenticated: true,
    accountLabel: session?.account.label,
    tier,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : undefined,
  };
}

export async function getCliStoredAuthProfile(): Promise<CliAuthProfile> {
  const session = await getCliSupabaseAuthCoordinator().loadSession();
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    accountLabel: session.account.label,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}
