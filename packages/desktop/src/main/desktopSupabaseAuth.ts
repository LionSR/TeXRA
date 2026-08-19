import { randomBytes } from 'node:crypto';

import PQueue from 'p-queue';
import { z } from 'zod';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  type OAuthProvider,
} from '@auth/config';
import {
  refreshRemoteAgentCatalogAfterSignOut,
  requireOAuthRedirectUrl,
} from '@auth/authFlowEffects';
import { createHostAuthCoordinator } from '@auth/SupabaseAuthCoordinator';
import {
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
} from '@auth/SupabaseSession';
import type { AuthCallbackUriParts } from '@auth/authCallback';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { TEXRA_PROTOCOL } from '../shared/desktopProtocol.js';
import type {
  DesktopProtocolCallback,
  DesktopProtocolCallbackRouter,
} from './desktopProtocolCallbacks.js';

const DESKTOP_PENDING_OAUTH_STATE_KEY = 'texra.desktop.pendingOAuthState';

const DesktopPendingOAuthStateSchema = z.object({
  createdAt: z.number(),
  nonce: z.string(),
});
type DesktopPendingOAuthState = z.infer<typeof DesktopPendingOAuthStateSchema>;

export interface DesktopSupabaseAuth {
  signIn(provider?: OAuthProvider): Promise<void>;
  signInAndWaitForSession(
    provider?: OAuthProvider,
    options?: { timeoutMs?: number },
  ): Promise<boolean>;
  signOut(): Promise<void>;
  dispose(): void;
}

export interface DesktopAuthCallbackState {
  hasPendingSignIn(): boolean;
  beginAuthAttempt(nonce: string): Promise<void>;
  /**
   * True only when a sign-in is pending AND its stored nonce equals `nonce`.
   * Binds an inbound callback to the attempt THIS client started, so a verified
   * but foreign-account token deeplink can't complete a sign-in (login-CSRF).
   */
  matchesPendingNonce(nonce: string | undefined): boolean;
  clearAwaitingCallback(nonce?: string): Promise<void>;
}

type DesktopAuthLog = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export interface DesktopSupabaseAuthHost {
  openExternalUrl(url: string): Promise<void>;
  showInfoMessage(message: string): Promise<void> | void;
  showErrorMessage(message: string): Promise<void> | void;
  onSessionChanged(): Promise<void> | void;
}

interface DesktopSupabaseAuthOptions {
  router: DesktopProtocolCallbackRouter;
  coordinator: DesktopAuthCoordinator;
  oauthClient: DesktopOAuthClient;
  callbackState: DesktopAuthCallbackState;
  host: DesktopSupabaseAuthHost;
  log: DesktopAuthLog;
}

export interface DesktopOAuthClient {
  auth: {
    signInWithOAuth(input: {
      provider: OAuthProvider;
      options: { redirectTo: string };
    }): Promise<{
      data: { url?: string | null };
      error: { message: string } | null;
    }>;
  };
}

/**
 * The session-storage surface this module drives. Token freshness and readiness
 * are not part of it: the coordinator registers itself with `SupabaseClient` as
 * the process-wide token provider, and every desktop token read goes through
 * there.
 */
export interface DesktopAuthCoordinator {
  storeSession(session: SupabaseSession): Promise<void>;
  clearSession(): Promise<void>;
  createSessionFromCallback(
    uri: AuthCallbackUriParts,
  ): Promise<SupabaseCallbackResult>;
}

export function createDesktopAuthCallbackState(
  log: DesktopAuthLog,
  store?: Pick<StateStore, 'get' | 'update'>,
): DesktopAuthCallbackState {
  let pendingState = readPendingOAuthState(store);
  const persistQueue = new PQueue({ concurrency: 1 });

  const persistPendingState = async (
    state: DesktopPendingOAuthState | null,
  ): Promise<void> => {
    if (!store) return;
    await persistQueue.add(() =>
      store.update(DESKTOP_PENDING_OAUTH_STATE_KEY, state),
    );
  };

  // A dropped persist leaves the expired nonce on disk; in-memory state is
  // already cleared, so the next launch re-expires it. Logged so the stale
  // record has a trace rather than appearing out of nowhere.
  const forgetExpiredPendingState = (): void => {
    pendingState = null;
    void persistPendingState(null).catch((error: unknown) => {
      log.debug(
        `Desktop pending OAuth state cleanup failed: ${toErrorMessage(error)}`,
      );
    });
  };

  if (pendingState && isPendingOAuthStateExpired(pendingState)) {
    forgetExpiredPendingState();
  }

  // True only while a non-expired sign-in attempt is pending; clears and
  // best-effort persists the reset once the stored attempt has expired.
  const hasValidPendingState = (): boolean => {
    if (!pendingState) return false;
    if (isPendingOAuthStateExpired(pendingState)) {
      forgetExpiredPendingState();
      return false;
    }
    return true;
  };

  return {
    hasPendingSignIn: hasValidPendingState,
    async beginAuthAttempt(nonce: string) {
      pendingState = { createdAt: Date.now(), nonce };
      await persistPendingState(pendingState);
    },
    matchesPendingNonce: (nonce: string | undefined) => {
      if (!nonce) return false;
      return hasValidPendingState() && pendingState?.nonce === nonce;
    },
    async clearAwaitingCallback(nonce?: string) {
      if (nonce && pendingState?.nonce !== nonce) return;
      pendingState = null;
      await persistPendingState(null);
    },
  };
}

function readPendingOAuthState(
  store: Pick<StateStore, 'get' | 'update'> | undefined,
): DesktopPendingOAuthState | null {
  const persisted = store?.get<unknown>(DESKTOP_PENDING_OAUTH_STATE_KEY, null);
  const parsed = DesktopPendingOAuthStateSchema.safeParse(persisted);
  return parsed.success ? parsed.data : null;
}

function isPendingOAuthStateExpired(state: DesktopPendingOAuthState): boolean {
  return Date.now() - state.createdAt > AUTH_CALLBACK_TIMEOUT_MS;
}

/**
 * One sign-in attempt. Object identity is the ownership token: every step that
 * can commit or clear auth state re-checks `activeAttempt === attempt`, so a
 * superseded attempt can neither store its session nor cancel the newer one.
 */
interface DesktopAuthAttempt {
  readonly nonce: string;
  /** Resolves the `signInAndWaitForSession` waiter attached to this attempt. */
  settle(success: boolean): void;
}

function createAuthAttempt(nonce: string): DesktopAuthAttempt {
  return { nonce, settle: () => {} };
}

export function createDesktopSupabaseAuth(
  options: DesktopSupabaseAuthOptions,
): DesktopSupabaseAuth {
  const { callbackState, coordinator, host, log, oauthClient, router } =
    options;
  // Serialized so a second deeplink cannot commit a session while the first is
  // still storing one.
  const callbackQueue = new PQueue({ concurrency: 1 });
  let activeAttempt: DesktopAuthAttempt | undefined;
  const ownsAttempt = (attempt: DesktopAuthAttempt): boolean =>
    activeAttempt === attempt;
  const authCommitQueue = new PQueue({ concurrency: 1 });
  // `add` widens to `T | void` to cover abort via signal/timeout; we pass
  // neither, so the task always runs and resolves with `T`.
  const runAuthCommit = <T>(commit: () => Promise<T>): Promise<T> =>
    authCommitQueue.add(commit) as Promise<T>;
  const invalidateActiveAttempt = (): void => {
    const superseded = activeAttempt;
    activeAttempt = undefined;
    superseded?.settle(false);
  };
  const settleAttempt = (
    attempt: DesktopAuthAttempt,
    success: boolean,
  ): void => {
    attempt.settle(success);
    if (ownsAttempt(attempt)) {
      activeAttempt = undefined;
    }
  };
  const waitForCompletion = (attempt: DesktopAuthAttempt, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        attempt.settle(false);
        if (ownsAttempt(attempt)) {
          activeAttempt = undefined;
          void callbackState
            .clearAwaitingCallback(attempt.nonce)
            .catch((error: unknown) => {
              log.debug(
                `Desktop sign-in timeout cleanup failed: ${toErrorMessage(error)}`,
              );
            });
        }
      }, timeoutMs);
      let settled = false;
      attempt.settle = (success) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(success);
      };
    });
  const runQueuedCallback = async (queued: {
    callback: DesktopProtocolCallback;
    attempt: DesktopAuthAttempt;
  }): Promise<void> => {
    try {
      const success = await processProtocolCallback(
        coordinator,
        queued.callback,
        host,
        log,
        () => ownsAttempt(queued.attempt),
        runAuthCommit,
      );
      settleAttempt(queued.attempt, success);
    } catch (error) {
      settleAttempt(queued.attempt, false);
      const message = toErrorMessage(error);
      log.error(`Desktop auth callback failed: ${message}`);
      try {
        await host.showErrorMessage(`Sign-in failed: ${message}`);
      } catch (notificationError) {
        log.warn(
          `Desktop sign-in error notification failed: ${toErrorMessage(notificationError)}`,
        );
      }
    }
  };
  const subscription = router.subscribe((callback) => {
    if (!callbackState.hasPendingSignIn()) {
      log.debug(
        'Desktop auth callback ignored because no sign-in is in progress',
      );
      return;
    }
    const callbackNonce =
      new URLSearchParams(callback.query).get('app_nonce') ?? undefined;
    if (!callbackNonce || !callbackState.matchesPendingNonce(callbackNonce)) {
      log.warn(
        'Desktop auth callback rejected: nonce mismatch (possible login-CSRF or stale callback)',
      );
      return;
    }
    activeAttempt ??= createAuthAttempt(callbackNonce);
    const claimedAttempt = activeAttempt;
    if (claimedAttempt.nonce !== callbackNonce) return;
    void callbackState
      .clearAwaitingCallback(callbackNonce)
      .catch((error: unknown) => {
        log.debug(
          `Desktop auth callback state clear failed: ${toErrorMessage(error)}`,
        );
      });
    if (callbackQueue.pending > 0) {
      log.debug(
        'Desktop auth callback queued while another callback is being processed',
      );
    }
    void callbackQueue.add(() =>
      runQueuedCallback({ callback, attempt: claimedAttempt }),
    );
  });

  const startSignIn = async (
    provider: OAuthProvider,
    onAttempt?: (attempt: DesktopAuthAttempt) => void,
  ): Promise<void> => {
    invalidateActiveAttempt();
    const nonce = randomBytes(16).toString('hex');
    const attempt = createAuthAttempt(nonce);
    activeAttempt = attempt;
    onAttempt?.(attempt);
    try {
      // Drain the commit queue before claiming the attempt, so a callback still
      // storing or clearing a session finishes against the attempt it owns.
      await runAuthCommit(async () => {});
      if (!ownsAttempt(attempt)) return;

      // Bind this attempt to a one-time nonce carried on the callback URL.
      // Supabase preserves redirect_to query params through to the callback
      // (the same mechanism the Codespaces ?state= routing token relies on),
      // so the nonce returns in the texra:// callback query — letting us reject
      // a foreign token deeplink delivered while a sign-in is merely pending.
      const callbackUri = getAuthCallbackUri(TEXRA_PROTOCOL);
      const sep = callbackUri.includes('?') ? '&' : '?';
      const redirectTo = `${callbackUri}${sep}app_nonce=${nonce}`;
      await callbackState.beginAuthAttempt(nonce);
      if (!ownsAttempt(attempt)) return;
      const { data, error } = await oauthClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      const authUrl = requireOAuthRedirectUrl(data, error);
      if (!ownsAttempt(attempt)) return;

      await host.openExternalUrl(authUrl);
      await host.showInfoMessage(
        'Complete sign-in in your browser. TeXRA updates automatically when it finishes.',
      );
    } catch (error) {
      if (ownsAttempt(attempt)) activeAttempt = undefined;
      await callbackState.clearAwaitingCallback(nonce);
      await host.showErrorMessage(`Sign-in failed: ${toErrorMessage(error)}`);
      throw error;
    }
  };

  return {
    signIn(provider = DEFAULT_OAUTH_PROVIDER) {
      return startSignIn(provider);
    },

    async signInAndWaitForSession(
      provider = DEFAULT_OAUTH_PROVIDER,
      waitOptions = {},
    ) {
      let startedAttempt: DesktopAuthAttempt | undefined;
      let completion: Promise<boolean> | undefined;
      try {
        await startSignIn(provider, (attempt) => {
          startedAttempt = attempt;
          completion = waitForCompletion(
            attempt,
            waitOptions.timeoutMs ?? AUTH_CALLBACK_TIMEOUT_MS,
          );
        });
      } catch (error) {
        startedAttempt?.settle(false);
        throw error;
      }
      return completion ?? false;
    },

    async signOut() {
      invalidateActiveAttempt();
      await runAuthCommit(async () => {
        await callbackState.clearAwaitingCallback();
        await coordinator.clearSession();
      });
      await refreshRemoteAgentCatalogAfterSignOut(
        invalidateRemoteAgentsAfterSignOut,
        (message) => log.warn(message),
      );
      await host.onSessionChanged();
    },

    dispose() {
      invalidateActiveAttempt();
      subscription.dispose();
    },
  };
}

export function createDesktopAuthCoordinator(options: {
  secrets: PlatformSecrets;
  log: DesktopAuthLog;
}): DesktopAuthCoordinator {
  return createHostAuthCoordinator({
    secrets: options.secrets,
    log: createSessionLog(options.log),
  });
}

async function processProtocolCallback(
  coordinator: DesktopAuthCoordinator,
  callback: DesktopProtocolCallback,
  host: DesktopSupabaseAuthHost,
  log: DesktopAuthLog,
  ownsAttempt: () => boolean,
  runAuthCommit: <T>(commit: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const result = await coordinator.createSessionFromCallback({
    path: callback.path,
    query: callback.query,
  });

  if (!result.success) {
    if (result.isAuthError) {
      const callbackError = new URLSearchParams(callback.query).get('error');
      if (callbackError === 'access_denied') {
        log.info('Desktop sign-in was cancelled in the system browser');
        return false;
      }
      try {
        await host.showErrorMessage(`Sign-in failed: ${result.error}`);
      } catch (error) {
        log.warn(
          `Desktop sign-in error notification failed: ${toErrorMessage(error)}`,
        );
      }
    } else {
      log.debug(`Desktop auth callback ignored: ${result.error}`);
    }
    return false;
  }

  return runAuthCommit(async () => {
    // The attempt can be invalidated at any await boundary (a newer sign-in
    // or a timeout). Once it is, the session must not be kept.
    const stillOwned = async (): Promise<boolean> => {
      if (ownsAttempt()) return true;
      await coordinator.clearSession();
      return false;
    };

    if (!ownsAttempt()) return false;
    await coordinator.storeSession(result.session);
    if (!(await stillOwned())) return false;

    try {
      await host.showInfoMessage(
        `Signed in as ${result.session.account.label}`,
      );
    } catch (error) {
      log.warn(`Desktop sign-in notification failed: ${toErrorMessage(error)}`);
    }
    if (!(await stillOwned())) return false;

    try {
      await host.onSessionChanged();
    } catch (error) {
      log.warn(`Desktop auth surface refresh failed: ${toErrorMessage(error)}`);
    }
    return stillOwned();
  });
}

function createSessionLog(log: DesktopAuthLog): SupabaseSessionLog {
  return {
    debug: (source, message, options) =>
      log.debug(`[${source}] ${message}`, options?.data),
    info: (source, message, options) =>
      log.info(`[${source}] ${message}`, options?.data),
    warn: (source, message, options) =>
      log.warn(`[${source}] ${message}`, options?.data),
    error: (source, message, options) =>
      log.error(`[${source}] ${message}`, options?.data),
  };
}
