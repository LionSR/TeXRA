import { z } from 'zod';

import { platform } from '@platform/platform';
import {
  getAgentsBySource,
  loadAgents,
  toRemoteAgentProfileData,
} from '@agent/index';
import { DEFAULT_OAUTH_PROVIDER, getAuthCallbackUri } from '@auth/config';
import {
  createSupabaseAuthCoordinator,
  createSupabaseSessionStorage,
} from '@auth/SupabaseAuthCoordinator';
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
import { FREE_TIER, type OAuthProvider } from '@auth/sharedConfig';
import type { AuthCallbackUriParts } from '@auth/core/authCallback';
import { toErrorMessage } from '@common/errors/errorMessage';
import type { RemoteAgent } from '@shared/schemas/profileViewMessages';
import { TEXRA_PROTOCOL } from '../desktopProtocol.js';
import type { StateStore } from '@platform/interfaces/state';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  DesktopProtocolCallback,
  DesktopProtocolCallbackRouter,
} from './desktopProtocolCallbacks.js';

const DESKTOP_PENDING_OAUTH_STATE_KEY = 'texra.desktop.pendingOAuthState';
const DESKTOP_PENDING_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const DesktopPendingOAuthStateSchema = z.object({
  createdAt: z.number(),
});
type DesktopPendingOAuthState = z.infer<typeof DesktopPendingOAuthStateSchema>;

export interface DesktopAuthProfileData {
  authenticated: boolean;
  user: { email: string; id: string } | null;
  tier: string;
  permissions: string[];
  remoteAgents: RemoteAgent[];
  apiAccessMode: 'included' | 'personal';
  allowedModels: string[] | null;
  accessExpiresAt?: string | null;
}

export interface DesktopSupabaseAuth {
  signIn(provider?: OAuthProvider): Promise<void>;
  signOut(): Promise<void>;
  getProfileData(): Promise<DesktopAuthProfileData>;
  dispose(): void;
}

export interface DesktopAuthCallbackState {
  hasPendingSignIn(): boolean;
  beginAuthAttempt(): Promise<void>;
  clearAwaitingCallback(): Promise<void>;
}

export interface DesktopSupabaseAuthOptions {
  router: DesktopProtocolCallbackRouter;
  secrets: PlatformSecrets;
  openExternalUrl(url: string): Promise<void>;
  showInfoMessage?(message: string): Promise<void> | void;
  showErrorMessage?(message: string): Promise<void> | void;
  onSessionChanged?: () => Promise<void> | void;
  log?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  coordinator?: DesktopAuthCoordinator;
  oauthClient?: DesktopOAuthClient;
  callbackState?: DesktopAuthCallbackState;
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

  const persistPendingState = async (
    state: DesktopPendingOAuthState | null,
  ): Promise<void> => {
    if (!store) return;
    await store.update(DESKTOP_PENDING_OAUTH_STATE_KEY, state);
  };

  return {
    hasPendingSignIn: () => {
      if (!pendingState) return false;
      if (isPendingOAuthStateExpired(pendingState)) {
        pendingState = null;
        void persistPendingState(null).catch(() => {});
        return false;
      }
      return true;
    },
    async beginAuthAttempt() {
      pendingState = { createdAt: Date.now() };
      await persistPendingState(pendingState);
    },
    async clearAwaitingCallback() {
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
  const pendingState = parsed.data;
  if (isPendingOAuthStateExpired(pendingState)) {
    void Promise.resolve(
      store?.update(DESKTOP_PENDING_OAUTH_STATE_KEY, null),
    ).catch(() => {});
    return null;
  }
  return pendingState;
}

function isPendingOAuthStateExpired(state: DesktopPendingOAuthState): boolean {
  return Date.now() - state.createdAt > DESKTOP_PENDING_OAUTH_STATE_TTL_MS;
}

export function createDesktopSupabaseAuth(
  options: DesktopSupabaseAuthOptions,
): DesktopSupabaseAuth {
  const coordinator =
    options.coordinator ?? createDesktopAuthCoordinator(options);
  const oauthClient = options.oauthClient ?? SupabaseClient.getClient();
  const callbackState =
    options.callbackState ?? createDesktopAuthCallbackState();
  const callbackQueue: DesktopProtocolCallback[] = [];
  let isProcessingCallbacks = false;
  const processCallbackQueue = async (): Promise<void> => {
    if (isProcessingCallbacks) return;
    isProcessingCallbacks = true;
    try {
      while (callbackQueue.length > 0) {
        const callback = callbackQueue.shift();
        if (!callback) continue;
        try {
          await processProtocolCallback(coordinator, callback, options);
        } catch (error) {
          const message = toErrorMessage(error);
          options.log?.error?.(`Desktop auth callback failed: ${message}`);
          await options.showErrorMessage?.(`Sign-in failed: ${message}`);
        }
      }
    } finally {
      isProcessingCallbacks = false;
      if (callbackQueue.length > 0) void processCallbackQueue();
    }
  };
  const subscription = options.router.subscribe((callback) => {
    if (!callbackState.hasPendingSignIn()) {
      options.log?.debug?.(
        'Desktop auth callback ignored because no sign-in is in progress',
      );
      return;
    }
    void callbackState.clearAwaitingCallback().catch((error: unknown) => {
      options.log?.debug?.(
        `Desktop auth callback state clear failed: ${toErrorMessage(error)}`,
      );
    });
    callbackQueue.push(callback);
    if (isProcessingCallbacks) {
      options.log?.debug?.(
        'Desktop auth callback queued while another callback is being processed',
      );
    }
    void processCallbackQueue();
  });

  return {
    async signIn(provider = DEFAULT_OAUTH_PROVIDER) {
      try {
        const redirectTo = getAuthCallbackUri(TEXRA_PROTOCOL);
        const { data, error } = await oauthClient.auth.signInWithOAuth({
          provider,
          options: { redirectTo },
        });
        if (error || !data.url) {
          throw new Error(
            `OAuth initialization failed: ${error?.message || 'missing auth URL'}`,
          );
        }

        await callbackState.beginAuthAttempt();
        await options.openExternalUrl(data.url);
        await options.showInfoMessage?.(
          'Complete sign-in in your browser. TeXRA will update when the browser returns to the desktop app.',
        );
      } catch (error) {
        await callbackState.clearAwaitingCallback();
        await options.showErrorMessage?.(
          `Sign-in failed: ${toErrorMessage(error)}`,
        );
        throw error;
      }
    },

    async signOut() {
      await callbackState.clearAwaitingCallback();
      await coordinator.clearSession();
      SupabaseClient.setTokenExpiry(null);
      clearDesktopServerSideKeyCaches(options.log);
      await options.onSessionChanged?.();
    },

    async getProfileData() {
      return loadDesktopAuthProfileData();
    },

    dispose() {
      subscription.dispose();
    },
  };
}

export function createDesktopAuthCoordinator(
  options: Pick<DesktopSupabaseAuthOptions, 'secrets' | 'log'>,
): DesktopAuthCoordinator {
  return createSupabaseAuthCoordinator({
    storage: createSupabaseSessionStorage(options.secrets),
    log: createSessionLog(options.log),
  });
}

export function initializeDesktopServerSideKeyAccess(
  log: DesktopSupabaseAuthOptions['log'],
): void {
  initializeServerSideKeyAccess(
    {
      state: platform().globalState,
      logger: createAuthServiceLogger(log),
    },
    {
      isAuthenticated: () => SupabaseClient.isAuthenticated(),
      getUserTier: () => SupabaseClient.getUserTier(),
      getAccessToken: () => SupabaseClient.getAccessToken(),
    },
  );
}

function clearDesktopServerSideKeyCaches(
  log: DesktopSupabaseAuthOptions['log'],
): void {
  try {
    getServerSideKeyService().clearAllCaches();
  } catch (error) {
    log?.debug?.(
      `Desktop server-side key cache clear skipped: ${toErrorMessage(error)}`,
    );
  }
}

async function processProtocolCallback(
  coordinator: DesktopAuthCoordinator,
  callback: DesktopProtocolCallback,
  options: DesktopSupabaseAuthOptions,
): Promise<void> {
  const result = await coordinator.createSessionFromCallback({
    path: callback.path,
    query: callback.query,
    fragment: callback.fragment,
  });

  if (!result.success) {
    if (result.isAuthError) {
      await options.showErrorMessage?.(`Sign-in failed: ${result.error}`);
    } else {
      options.log?.debug?.(`Desktop auth callback ignored: ${result.error}`);
    }
    return;
  }

  await coordinator.storeSession(result.session);
  clearDesktopServerSideKeyCaches(options.log);
  await options.showInfoMessage?.(
    `Signed in as ${result.session.account.label}`,
  );
  await options.onSessionChanged?.();
}

async function loadDesktopAuthProfileData(): Promise<DesktopAuthProfileData> {
  const authenticated = await SupabaseClient.isAuthenticated();
  if (!authenticated) return unauthenticatedProfileData();

  const user = await SupabaseClient.getUser();
  let authContext: { tier: string; permissions: string[] } = {
    tier: FREE_TIER,
    permissions: [],
  };
  try {
    authContext = await SupabaseClient.getUserAuthContext();
  } catch {
    // Keep the UI signed in even if profile metadata is temporarily unavailable.
  }

  let apiAccessMode: 'included' | 'personal' = 'personal';
  let allowedModels: string[] | null = [];
  let accessExpiresAt: string | null = null;
  try {
    const serverSideKeyService = getServerSideKeyService();
    apiAccessMode = serverSideKeyService.getUseIncludedModelAccess()
      ? 'included'
      : 'personal';
    allowedModels = (await serverSideKeyService.canUseServerSideKeys())
      ? serverSideKeyService.getAllowedModelsForCurrentUser()
      : [];
    accessExpiresAt =
      serverSideKeyService.getAccessExpirationDate()?.toISOString() ?? null;
  } catch {
    // Server-side key access is optional; personal provider keys still work.
  }

  let remoteAgents: RemoteAgent[] = [];
  try {
    await loadAgents();
    remoteAgents = getAgentsBySource('remote').map(toRemoteAgentProfileData);
  } catch {
    // Keep auth/profile UI usable even if agent registry refresh fails.
  }

  return {
    authenticated: true,
    user: {
      email: user?.email ?? 'N/A',
      id: user?.id ?? '',
    },
    tier: authContext.tier,
    permissions: authContext.permissions,
    remoteAgents,
    apiAccessMode,
    allowedModels,
    accessExpiresAt,
  };
}

export function unauthenticatedProfileData(): DesktopAuthProfileData {
  return {
    authenticated: false,
    user: null,
    tier: FREE_TIER,
    permissions: [],
    remoteAgents: [],
    apiAccessMode: 'personal',
    allowedModels: [],
    accessExpiresAt: null,
  };
}

function createSessionLog(
  log: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> | undefined,
): SupabaseSessionLog {
  return {
    debug: (source, message) => log?.debug?.(`[${source}] ${message}`),
    info: (source, message) => log?.info?.(`[${source}] ${message}`),
    warn: (source, message) => log?.warn?.(`[${source}] ${message}`),
    error: (source, message) => log?.error?.(`[${source}] ${message}`),
  };
}

function createAuthServiceLogger(
  log: Pick<Console, 'info' | 'error'> | undefined,
): AuthServiceLogger {
  return {
    info: (source, message) => log?.info?.(`[${source}] ${message}`),
    error: (source, message) => log?.error?.(`[${source}] ${message}`),
  };
}
