// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports
import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import {
  installAuthProgramEdge,
  runAuthProgram,
  unwrapAuthPortCause,
} from '@auth/authProgram';
import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';
import {
  refreshRemoteAgentCatalogAfterSignOut,
  requireOAuthRedirectUrl,
} from '@auth/authFlowEffects';
import { createSupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import {
  toStorableSupabaseSession,
  type SupabaseSession,
  type SupabaseSessionCoordinator,
  type SupabaseSessionLog,
} from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { completeDeviceSession } from '@auth/oauth/deviceAuthorization';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import { openBrowser } from './browser';
import {
  startLoopbackCallbackServer,
  type LoopbackCallbackServer,
} from './supabaseAuthCallbackServer';
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

let auth: SupabaseAuthShape | undefined;
let activeAuthLog: SupabaseSessionLog | undefined;
const deferredAuthLog: SupabaseSessionLog = {
  debug: (channel, message) => activeAuthLog?.debug?.(channel, message),
  info: (channel, message) => activeAuthLog?.info?.(channel, message),
  warn: (channel, message) => activeAuthLog?.warn?.(channel, message),
  error: (channel, message) => activeAuthLog?.error?.(channel, message),
};

/**
 * The CLI's account plane, created once beside the process runtime install
 * (`installCliProcessRuntime` passes it to `installProcessRuntime`). Every
 * `CliSecrets` instance over the same storage root is equivalent (one shared
 * mutation lane), so the first build wins for the life of the process.
 */
export function ensureCliSupabaseAuth(
  secrets: PlatformSecrets,
): SupabaseAuthShape {
  auth ??= createSupabaseAuth({ secrets, log: deferredAuthLog });
  return auth;
}

export function initializeCliSupabaseAuth(
  runtime: ProcessRuntime,
  secrets: PlatformSecrets,
  log?: SupabaseSessionLog,
): void {
  // The auth subsystem's run edge lives at this host entry (PRD R1), installed
  // on every init so every later Promise-facing auth surface settles on the
  // process runtime the composition root hands in.
  installAuthProgramEdge((program) => runtime.runPromiseExit(program));
  activeAuthLog = log ?? activeAuthLog;
  ensureCliSupabaseAuth(secrets);
}

/**
 * The account plane the CLI composition root built. The secret store it reads
 * is the root's own, threaded in above, so a Promise-facing auth surface
 * reached before `initCliPlatform` has run says so instead of reconstructing
 * a plane from a store it would have to look up.
 */
function cliSupabaseAuth(): SupabaseAuthShape {
  if (!auth) {
    throw new Error(
      'CLI Supabase auth is not initialized: installCliProcessRuntime() builds it at the CLI composition root.',
    );
  }
  return auth;
}

export async function signInCliSupabase(
  runtime: ProcessRuntime,
  options: CliLoginOptions = {},
): Promise<SupabaseSession> {
  const authCoordinator = cliSupabaseAuth().coordinator;
  const callbackServer = await runtime.runPromise(
    startLoopbackCallbackServer(runtime, authCoordinator),
  );
  try {
    const exit = await runtime.runPromiseExit(
      loopbackSignIn(authCoordinator, callbackServer, options),
      { signal: options.signal },
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // A storage commit that began before cancellation still settles the
    // sign-in: v4 fiber interruption is sticky (once delivered it re-fires at
    // every interruptible boundary), so the wait cannot recover in-runtime —
    // the Promise edge re-awaits the session on a fresh fiber instead. This
    // is the historical abort contract (`commitStarted`), now settled at the
    // boundary (R7: a product edge may represent cancellation as data).
    if (Cause.hasInterrupts(exit.cause) && callbackServer.commitStarted) {
      return await runtime.runPromise(callbackServer.waitForSession);
    }
    throw Cause.squash(exit.cause);
  } finally {
    await runtime.runPromise(callbackServer.close);
  }
}

/**
 * The loopback sign-in program: drive the OAuth redirect and browser launch,
 * then await the callback session. The caller's cancellation signal arrives
 * as fiber interruption (R5), which `LoopbackCallbackServer.cancel` turns
 * into refused callbacks; the server is closed by the Promise edge's finally
 * on success, failure, and cancellation alike.
 */
const loopbackSignIn = (
  authCoordinator: SupabaseSessionCoordinator,
  callbackServer: LoopbackCallbackServer,
  options: CliLoginOptions,
): Effect.Effect<SupabaseSession, Error> => {
  const provider = options.provider ?? DEFAULT_OAUTH_PROVIDER;
  const queryParams = buildOAuthQueryParams(provider, options);
  return Effect.gen(function* () {
    if (options.selectAccount || options.loginHint) {
      yield* authCoordinator
        .clearSession()
        .pipe(Effect.mapError(unwrapAuthPortCause));
    }
    const { data, error } = yield* Effect.tryPromise({
      try: () =>
        cliSupabaseAuth().client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: callbackServer.redirectTo,
            ...(queryParams && { queryParams }),
          },
        }),
      catch: (cause) => ensureError(cause),
    });
    const authUrl = yield* Effect.try({
      try: () => requireOAuthRedirectUrl(data, error),
      catch: (cause) => ensureError(cause),
    });

    options.onAuthUrl?.(authUrl);
    if (options.openBrowser ?? true) {
      // A completed callback supersedes the launcher result, while callback
      // failure or cancellation still preempts a stalled launcher.
      yield* Effect.raceFirst(
        Effect.tryPromise({
          try: () =>
            openBrowser(
              authUrl,
              options.manualBrowserHint ?? 'texra login --no-browser',
            ),
          catch: (cause) => ensureError(cause),
        }),
        callbackServer.sessionSettled,
      );
    }

    return yield* callbackServer.waitForSession;
  }).pipe(Effect.onInterrupt(() => callbackServer.cancel));
};

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
  const authCoordinator = cliSupabaseAuth().coordinator;
  const authorization = yield* requestDeviceAuthorization();
  options.onDeviceCode?.(authorization);
  const exchange = yield* pollForDeviceSession(authorization);
  // The token endpoint mints a native GoTrue session, so
  // standard Supabase refresh applies — no custom refresh flag.
  const session: SupabaseSession = toStorableSupabaseSession(exchange);
  yield* completeDeviceSession(() => authCoordinator.storeSession(session));
  return session;
});

export async function signOutCliSupabase(): Promise<void> {
  const authCoordinator = cliSupabaseAuth().coordinator;
  await runAuthProgram(authCoordinator.clearSession());
  await runAuthProgram(
    refreshRemoteAgentCatalogAfterSignOut(
      invalidateRemoteAgentsAfterSignOut(),
      (message) => activeAuthLog?.warn?.('cli-auth', message),
    ),
  );
}

export async function getCliAuthProfile(): Promise<CliAuthProfile> {
  const authCoordinator = cliSupabaseAuth().coordinator;

  // Classify the stored session instead of asking "is there a token": a
  // GoTrue outage leaves the session stored and usable once the service
  // recovers, so reporting it as signed out invites a needless re-login.
  const sessionState = await runAuthProgram(
    authCoordinator.getStoredSessionState(),
  );
  if (sessionState !== 'authenticated') {
    return {
      authenticated: false,
      sessionState,
    };
  }

  const session = await runAuthProgram(authCoordinator.loadSession());
  return {
    authenticated: true,
    sessionState,
    accountLabel: session?.account.label,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : undefined,
  };
}
