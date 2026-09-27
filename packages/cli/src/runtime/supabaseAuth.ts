// Third-party imports
import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

// Local imports
import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { unwrapAuthPortCause } from '@auth/authProgram';
import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';
import { createSupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import {
  toStorableSupabaseSession,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import type { StoredSessionState } from '@auth/TokenProvider';
import { completeDeviceSession } from '@auth/oauth/deviceAuthorization';
import { SupabaseSignInCoordinator } from '@controllers/auth/supabaseSignIn';
import {
  memoryPendingOAuthSlots,
  PendingOAuthStore,
} from '@controllers/auth/pendingOAuthStore';
import type {
  AgentCatalogServices,
  ProcessRuntime,
} from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { RESEARCHER_ACCESS } from '@ui/copy/onboarding';
import { ensureError } from '@utils/errors/errorMessage';
import { processEnvConfigLayer } from '@utils/system/envFlags';

// Local file imports
import { presentCliSignInUrl, type CliSignInProgress } from './signInUrl';
import { loopbackCallbackTransport } from './supabaseAuthCallbackServer';
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
  noBrowser: boolean;
  selectAccount?: boolean;
  loginHint?: string;
  /** Where the sign-in URL and the launch status are shown. */
  writeProgress: CliSignInProgress;
}

let auth: SupabaseAuthShape | undefined;

/**
 * The CLI's account plane, created once beside the process runtime install
 * (`installCliProcessRuntime` passes it to `installProcessRuntime`). Every
 * `CliSecrets` instance over the same storage root is equivalent (one shared
 * mutation lane), so the first build wins for the life of the process.
 */
export function ensureCliSupabaseAuth(
  secrets: PlatformSecrets,
): SupabaseAuthShape {
  // The plane is built before the process runtime it is served on, so it is
  // built here on a bootstrap fiber. Construction reads no service; the GoTrue
  // storage callbacks it captures read secrets, which consult the process
  // environment, so the fiber carries the env ConfigProvider the runtime serves.
  auth ??= Effect.runSync(
    createSupabaseAuth({ secrets }).pipe(Effect.provide(processEnvConfigLayer)),
  );
  return auth;
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

/**
 * The CLI's browser sign-in: one shared sign-in attempt over the loopback
 * callback transport. Cancellation arrives as fiber interruption from the
 * command's own run edge, and the callback server's teardown is the release
 * half of the transport's acquisition, which runs whether the attempt
 * succeeds, fails, or is cancelled.
 */
export const signInCliSupabase = Effect.fn('supabaseAuth.signInCliSupabase')(
  function* (runtime: ProcessRuntime, options: CliLoginOptions) {
    const auth = cliSupabaseAuth();
    const provider = options.provider ?? DEFAULT_OAUTH_PROVIDER;
    // An account switch starts from no session at all, so the picker the
    // provider shows is not shortcut by the one already signed in.
    if (options.selectAccount || options.loginHint) {
      yield* auth.coordinator
        .clearSession()
        .pipe(Effect.mapError(unwrapAuthPortCause));
    }
    // The loopback port runs its launcher with nothing in context, so the
    // spawner this program holds is handed to each launch.
    const spawner = yield* ChildProcessSpawner;
    const coordinator = new SupabaseSignInCoordinator({
      auth,
      store: new PendingOAuthStore(memoryPendingOAuthSlots()),
      transport: loopbackCallbackTransport({
        runtime,
        openBrowser: (url) =>
          presentCliSignInUrl({
            writeProgress: options.writeProgress,
            displayName: RESEARCHER_ACCESS.label,
            url,
            noBrowser: options.noBrowser,
          }).pipe(Effect.provideService(ChildProcessSpawner, spawner)),
      }),
    });
    return yield* coordinator
      .signIn({
        provider,
        queryParams: buildOAuthQueryParams(provider, options),
      })
      .pipe(Effect.mapError(ensureError));
  },
);

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

/**
 * Sign out of the TeXRA account: clear the stored session, then refresh the
 * local agent catalog. A plane the composition root never built, and a
 * storage rejection, both fail as the error the caller reports.
 */
export function signOutCliSupabase(): Effect.Effect<
  void,
  Error,
  AgentCatalogServices
> {
  return Effect.gen(function* () {
    const authCoordinator = yield* Effect.try({
      try: () => cliSupabaseAuth().coordinator,
      catch: ensureError,
    });
    yield* authCoordinator
      .clearSession()
      .pipe(Effect.mapError(unwrapAuthPortCause));
    yield* invalidateRemoteAgentsAfterSignOut();
  });
}

export function getCliAuthProfile(): Effect.Effect<CliAuthProfile, Error> {
  return Effect.gen(function* () {
    const authCoordinator = yield* Effect.try({
      try: () => cliSupabaseAuth().coordinator,
      catch: ensureError,
    });

    // Classify the stored session instead of asking "is there a token": a
    // GoTrue outage leaves the session stored and usable once the service
    // recovers, so reporting it as signed out invites a needless re-login.
    const sessionState = yield* authCoordinator.getStoredSessionState();
    if (sessionState !== 'authenticated') {
      return {
        authenticated: false,
        sessionState,
      };
    }

    const session = yield* authCoordinator
      .loadSession()
      .pipe(Effect.mapError(unwrapAuthPortCause));
    return {
      authenticated: true,
      sessionState,
      accountLabel: session?.account.label,
      expiresAt: session
        ? new Date(session.expiresAt).toISOString()
        : undefined,
    };
  });
}
