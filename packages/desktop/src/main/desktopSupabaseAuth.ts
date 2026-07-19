import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { platform } from '@platform/platform';
import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { DEFAULT_OAUTH_PROVIDER, getAuthCallbackUri } from '@auth/config';
import { createHostAuthCoordinator } from '@auth/SupabaseAuthCoordinator';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
} from '@auth/SupabaseSession';
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';
import type { AuthServiceLogger } from '@auth/serviceLogger';
import { type OAuthProvider } from '@auth/config';
import type { AuthCallbackUriParts } from '@auth/core/authCallback';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { TEXRA_PROTOCOL } from '../desktopProtocol.js';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  DesktopProtocolCallback,
  DesktopProtocolCallbackRouter,
} from './desktopProtocolCallbacks.js';

const DESKTOP_PENDING_OAUTH_STATE_KEY = 'texra.desktop.pendingOAuthState';
const DESKTOP_PENDING_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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

export interface DesktopAuthCoordinator {
  loadSession(): Promise<SupabaseSession | null>;
  storeSession(session: SupabaseSession): Promise<void>;
  clearSession(): Promise<void>;
  createSessionFromCallback(
    uri: AuthCallbackUriParts,
  ): Promise<SupabaseCallbackResult>;
  whenReady(): Promise<void>;
  ensureFreshToken(forceRefresh?: boolean): Promise<string | null>;
  getSessionTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null>;
}

export function createDesktopAuthCallbackState(
  store?: Pick<StateStore, 'get' | 'update'>,
): DesktopAuthCallbackState {
  let pendingState = readPendingOAuthState(store);
  let persistQueue = Promise.resolve();

  const persistPendingState = async (
    state: DesktopPendingOAuthState | null,
  ): Promise<void> => {
    if (!store) return;
    const update = persistQueue.then(() =>
      store.update(DESKTOP_PENDING_OAUTH_STATE_KEY, state),
    );
    persistQueue = update.catch(() => undefined);
    await update;
  };

  if (pendingState && isPendingOAuthStateExpired(pendingState)) {
    pendingState = null;
    void persistPendingState(null).catch(() => {});
  }

  // True only while a non-expired sign-in attempt is pending; clears and
  // best-effort persists the reset once the stored attempt has expired.
  const hasValidPendingState = (): boolean => {
    if (!pendingState) return false;
    if (isPendingOAuthStateExpired(pendingState)) {
      pendingState = null;
      void persistPendingState(null).catch(() => {});
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
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function isPendingOAuthStateExpired(state: DesktopPendingOAuthState): boolean {
  return Date.now() - state.createdAt > DESKTOP_PENDING_OAUTH_STATE_TTL_MS;
}

export function createDesktopSupabaseAuth(
  options: DesktopSupabaseAuthOptions,
): DesktopSupabaseAuth {
  const { callbackState, coordinator, host, log, oauthClient, router } =
    options;
  const callbackQueue: Array<{
    callback: DesktopProtocolCallback;
    nonce: string;
    generation: number;
  }> = [];
  const pendingCompletions = new Map<
    string,
    { settle(success: boolean): void }
  >();
  const settleCompletion = (nonce: string, success: boolean): void => {
    pendingCompletions.get(nonce)?.settle(success);
  };
  const settleAllCompletions = (): void => {
    for (const completion of pendingCompletions.values()) {
      completion.settle(false);
    }
  };
  let attemptGeneration = 0;
  let activeAttempt:
    { readonly generation: number; readonly nonce: string } | undefined;
  const ownsAttempt = (generation: number, nonce: string): boolean =>
    activeAttempt?.generation === generation && activeAttempt.nonce === nonce;
  let authCommitQueue = Promise.resolve();
  const runAuthCommit = <T>(commit: () => Promise<T>): Promise<T> => {
    const result = authCommitQueue.then(commit);
    authCommitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const invalidateActiveAttempt = (): void => {
    attemptGeneration += 1;
    activeAttempt = undefined;
    settleAllCompletions();
  };
  const waitForCompletion = (
    nonce: string,
    generation: number,
    timeoutMs: number,
  ) =>
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        settleCompletion(nonce, false);
        if (ownsAttempt(generation, nonce)) {
          activeAttempt = undefined;
          void callbackState.clearAwaitingCallback(nonce).catch(() => {});
        }
      }, timeoutMs);
      let settled = false;
      pendingCompletions.set(nonce, {
        settle(success) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          pendingCompletions.delete(nonce);
          resolve(success);
        },
      });
    });
  let isProcessingCallbacks = false;
  const processCallbackQueue = async (): Promise<void> => {
    if (isProcessingCallbacks) return;
    isProcessingCallbacks = true;
    try {
      while (callbackQueue.length > 0) {
        const queued = callbackQueue.shift();
        if (!queued) continue;
        try {
          const success = await processProtocolCallback(
            coordinator,
            queued.callback,
            host,
            log,
            () => ownsAttempt(queued.generation, queued.nonce),
            runAuthCommit,
          );
          settleCompletion(queued.nonce, success);
          if (ownsAttempt(queued.generation, queued.nonce)) {
            activeAttempt = undefined;
          }
        } catch (error) {
          settleCompletion(queued.nonce, false);
          if (ownsAttempt(queued.generation, queued.nonce)) {
            activeAttempt = undefined;
          }
          const message = toErrorMessage(error);
          log.error(`Desktop auth callback failed: ${message}`);
          await host.showErrorMessage(`Sign-in failed: ${message}`);
        }
      }
    } finally {
      isProcessingCallbacks = false;
      if (callbackQueue.length > 0) void processCallbackQueue();
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
    if (!activeAttempt) {
      attemptGeneration += 1;
      activeAttempt = { generation: attemptGeneration, nonce: callbackNonce };
    }
    const claimedAttempt = activeAttempt;
    if (claimedAttempt.nonce !== callbackNonce) return;
    void callbackState
      .clearAwaitingCallback(callbackNonce)
      .catch((error: unknown) => {
        log.debug(
          `Desktop auth callback state clear failed: ${toErrorMessage(error)}`,
        );
      });
    callbackQueue.push({
      callback,
      nonce: callbackNonce,
      generation: claimedAttempt.generation,
    });
    if (isProcessingCallbacks) {
      log.debug(
        'Desktop auth callback queued while another callback is being processed',
      );
    }
    void processCallbackQueue();
  });

  const startSignIn = async (
    provider: OAuthProvider,
    onAttempt?: (attempt: { generation: number; nonce: string }) => void,
  ): Promise<void> => {
    invalidateActiveAttempt();
    const generation = attemptGeneration;
    const nonce = randomBytes(16).toString('hex');
    activeAttempt = { generation, nonce };
    onAttempt?.({ generation, nonce });
    try {
      await runAuthCommit(async () => {});
      if (!ownsAttempt(generation, nonce)) return;

      // Bind this attempt to a one-time nonce carried on the callback URL.
      // Supabase preserves redirect_to query params through to the callback
      // (the same mechanism the Codespaces ?state= routing token relies on),
      // so the nonce returns in the texra:// callback query — letting us reject
      // a foreign token deeplink delivered while a sign-in is merely pending.
      const callbackUri = getAuthCallbackUri(TEXRA_PROTOCOL);
      const sep = callbackUri.includes('?') ? '&' : '?';
      const redirectTo = `${callbackUri}${sep}app_nonce=${nonce}`;
      await callbackState.beginAuthAttempt(nonce);
      if (!ownsAttempt(generation, nonce)) return;
      const { data, error } = await oauthClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (error || !data.url) {
        throw new Error(
          `OAuth initialization failed: ${error?.message || 'missing auth URL'}`,
        );
      }
      if (!ownsAttempt(generation, nonce)) return;

      await host.openExternalUrl(data.url);
      await host.showInfoMessage(
        'Complete sign-in in your browser. TeXRA will update when the browser returns to the desktop app.',
      );
    } catch (error) {
      if (ownsAttempt(generation, nonce)) activeAttempt = undefined;
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
      let nonce: string | undefined;
      let completion: Promise<boolean> | undefined;
      try {
        await startSignIn(provider, (attempt) => {
          nonce = attempt.nonce;
          completion = waitForCompletion(
            attempt.nonce,
            attempt.generation,
            waitOptions.timeoutMs ?? DESKTOP_PENDING_OAUTH_STATE_TTL_MS,
          );
        });
      } catch (error) {
        if (nonce) settleCompletion(nonce, false);
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
      SupabaseClient.setTokenExpiry(null);
      clearDesktopServerSideKeyCaches(log);
      await invalidateRemoteAgentsAfterSignOut().catch((error: unknown) => {
        log.warn(
          `Local agent catalog refresh failed after sign-out: ${toErrorMessage(error)}`,
        );
      });
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

export function initializeDesktopServerSideKeyAccess(
  log: DesktopAuthLog,
): void {
  initializeServerSideKeyAccess({
    state: platform().globalState,
    logger: createAuthServiceLogger(log),
  });
}

function clearDesktopServerSideKeyCaches(log: DesktopAuthLog): void {
  try {
    getServerSideKeyService().clearAllCaches({ resetQuotaFlip: true });
  } catch (error) {
    log.debug(
      `Desktop server-side key cache clear skipped: ${toErrorMessage(error)}`,
    );
  }
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
    fragment: callback.fragment,
  });

  if (!result.success) {
    if (result.isAuthError) {
      await host.showErrorMessage(`Sign-in failed: ${result.error}`);
    } else {
      log.debug(`Desktop auth callback ignored: ${result.error}`);
    }
    return false;
  }

  return runAuthCommit(async () => {
    if (!ownsAttempt()) return false;

    await coordinator.storeSession(result.session);
    if (!ownsAttempt()) {
      await coordinator.clearSession();
      return false;
    }

    clearDesktopServerSideKeyCaches(log);
    try {
      await host.showInfoMessage(
        `Signed in as ${result.session.account.label}`,
      );
    } catch (error) {
      log.warn(`Desktop sign-in notification failed: ${toErrorMessage(error)}`);
    }
    if (!ownsAttempt()) {
      await coordinator.clearSession();
      return false;
    }
    try {
      await host.onSessionChanged();
    } catch (error) {
      log.warn(`Desktop auth surface refresh failed: ${toErrorMessage(error)}`);
    }
    if (!ownsAttempt()) {
      await coordinator.clearSession();
      return false;
    }
    return true;
  });
}

function createSessionLog(log: DesktopAuthLog): SupabaseSessionLog {
  return {
    debug: (source, message) => log.debug(`[${source}] ${message}`),
    info: (source, message) => log.info(`[${source}] ${message}`),
    warn: (source, message) => log.warn(`[${source}] ${message}`),
    error: (source, message) => log.error(`[${source}] ${message}`),
  };
}

function createAuthServiceLogger(
  log: Pick<DesktopAuthLog, 'info' | 'error'>,
): AuthServiceLogger {
  return {
    info: (source, message) => log.info(`[${source}] ${message}`),
    error: (source, message) => log.error(`[${source}] ${message}`),
  };
}
