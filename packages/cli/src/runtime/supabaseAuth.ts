// Third-party imports
import { Effect } from 'effect';

// Local imports
import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';
import {
  refreshRemoteAgentCatalogAfterSignOut,
  requireOAuthRedirectUrl,
} from '@auth/authFlowEffects';
import { createHostAuthCoordinator } from '@auth/SupabaseAuthCoordinator';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  toStorableSupabaseSession,
  type SupabaseSession,
  type SupabaseSessionCoordinator,
  type SupabaseSessionLog,
} from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { completeDeviceSession } from '@auth/oauth/deviceAuthorization';
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

// Local file imports
import { openBrowser } from './browser';
import { startLoopbackCallbackServer } from './supabaseAuthCallbackServer';
import {
  pollForDeviceSession,
  requestDeviceAuthorization,
  type DeviceAuthorization,
} from './supabaseAuthDeviceCode';

export interface CliAuthProfile {
  authenticated: boolean;
  /**
   * Health of the stored GoTrue session. `transient` means the
   * authentication service could not be reached, so the stored session is
   * intact and signing in again would be premature.
   */
  sessionState?: StoredSessionState;
  accountLabel?: string;
  expiresAt?: string;
  /** Extra status context. */
  note?: string;
}

interface CliLoginOptions {
  provider?: OAuthProvider;
  openBrowser?: boolean;
  selectAccount?: boolean;
  loginHint?: string;
  onAuthUrl?: (url: string) => void;
  manualBrowserHint?: string;
  signal?: AbortSignal;
}

const CLI_MANUAL_AUTH_URL_PROMPT =
  'Open this URL in a browser that can reach this terminal session:';

const CLI_MANUAL_AUTH_REMOTE_HINT =
  'Remote SSH/container users may need to forward the callback port.';

export function formatCliManualAuthUrlMessage(url: string): string {
  return [CLI_MANUAL_AUTH_URL_PROMPT, url, CLI_MANUAL_AUTH_REMOTE_HINT].join(
    '\n',
  );
}

let coordinator: SupabaseSessionCoordinator | undefined;
let coordinatorSecrets: PlatformSecrets | undefined;
let activeAuthLog: SupabaseSessionLog | undefined;
const deferredAuthLog: SupabaseSessionLog = {
  debug: (channel, message) => activeAuthLog?.debug?.(channel, message),
  info: (channel, message) => activeAuthLog?.info?.(channel, message),
  warn: (channel, message) => activeAuthLog?.warn?.(channel, message),
  error: (channel, message) => activeAuthLog?.error?.(channel, message),
};

export function initializeCliSupabaseAuth(
  log?: SupabaseSessionLog,
): SupabaseSessionCoordinator {
  activeAuthLog = log ?? activeAuthLog;
  const secrets = platform().secrets;
  if (!coordinator || coordinatorSecrets !== secrets) {
    coordinator = createHostAuthCoordinator({
      secrets,
      log: deferredAuthLog,
    });
    coordinatorSecrets = secrets;
  }
  return coordinator;
}

export async function signInCliSupabase(
  options: CliLoginOptions = {},
): Promise<SupabaseSession> {
  const provider = options.provider ?? DEFAULT_OAUTH_PROVIDER;
  const authCoordinator = initializeCliSupabaseAuth();
  const callbackServer = await startLoopbackCallbackServer(authCoordinator);
  const redirectTo = callbackServer.redirectTo;
  const queryParams = buildOAuthQueryParams(provider, options);

  try {
    options.signal?.throwIfAborted();
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
    const authUrl = requireOAuthRedirectUrl(data, error);

    options.signal?.throwIfAborted();
    const sessionPromise = callbackServer.waitForSession(options.signal);
    options.onAuthUrl?.(authUrl);
    if (options.openBrowser ?? true) {
      const browserLaunch = openBrowser(
        authUrl,
        options.manualBrowserHint ?? 'texra login --no-browser',
      );
      // A completed callback supersedes the launcher result, while callback
      // failure or cancellation still preempts a stalled launcher.
      await Promise.race([browserLaunch, sessionPromise.then(() => undefined)]);
    }

    return await sessionPromise;
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

interface CliDeviceLoginOptions {
  /** Called once with the code and verification URL the user must open. */
  onDeviceCode?: (authorization: DeviceAuthorization) => void;
}

/**
 * Device-code sign-in program for headless terminals (SSH, WSL2, containers)
 * where the loopback callback server can't be reached. The user approves a
 * short code from a browser on any device; no callback port is needed here.
 * The command action or slash handler runs it, where its cancellation signal
 * (if any) becomes fiber interruption.
 */
export const signInCliSupabaseDeviceCode = Effect.fn(
  'supabaseAuth.signInCliSupabaseDeviceCode',
)(function* (options: CliDeviceLoginOptions = {}) {
  const authCoordinator = initializeCliSupabaseAuth();
  const authorization = yield* requestDeviceAuthorization();
  options.onDeviceCode?.(authorization);
  const exchange = yield* pollForDeviceSession(authorization);
  // The token endpoint mints a native GoTrue session (auth-github shape), so
  // standard Supabase refresh applies — no custom refresh flag.
  const session: SupabaseSession = toStorableSupabaseSession(exchange);
  yield* completeDeviceSession(() => authCoordinator.storeSession(session));
  return session;
});

export async function signOutCliSupabase(): Promise<void> {
  const authCoordinator = initializeCliSupabaseAuth();
  await authCoordinator.clearSession();
  await refreshRemoteAgentCatalogAfterSignOut(
    invalidateRemoteAgentsAfterSignOut,
    (message) => activeAuthLog?.warn?.('cli-auth', message),
  );
}

export async function getCliAuthProfile(): Promise<CliAuthProfile> {
  const authCoordinator = initializeCliSupabaseAuth();

  // Classify the stored session instead of asking "is there a token": a
  // GoTrue outage leaves the session stored and usable once the service
  // recovers, so reporting it as signed out invites a needless re-login.
  const sessionState = await SupabaseClient.getStoredSessionState();
  if (sessionState !== 'authenticated') {
    return {
      authenticated: false,
      sessionState,
    };
  }

  const session = await authCoordinator.loadSession();
  return {
    authenticated: true,
    sessionState,
    accountLabel: session?.account.label,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : undefined,
  };
}
