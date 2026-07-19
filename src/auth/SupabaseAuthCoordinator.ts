import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  GITHUB_TOKEN_REFRESH_URL,
  SUPABASE_CONFIG,
  SUPABASE_SESSION_KEY,
  TOKEN_REFRESH_THRESHOLD_MS,
} from './config';
import { SupabaseClient } from './SupabaseClient';
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  SupabaseSessionCoordinator,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './SupabaseSession';

export const DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS = 30000;

interface SupabaseSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HostAuthCoordinatorInit {
  readonly secrets: SupabaseSecretStore;
  readonly log?: SupabaseSessionLog;
  /**
   * Gate the coordinator awaits before processing OAuth callbacks. The VS
   * Code host uses this to ensure the URI handler is installed first.
   */
  readonly whenReady?: () => Promise<void>;
}

export function createHostAuthCoordinator(
  init: HostAuthCoordinatorInit,
): SupabaseSessionCoordinator {
  try {
    SupabaseClient.initialize(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publicKey);
  } catch (error) {
    throw new Error(
      `Supabase authentication is not configured: ${toErrorMessage(error)}`,
    );
  }
  const storage: SupabaseSessionStorage = {
    get: () => init.secrets.get(SUPABASE_SESSION_KEY),
    store: (sessionData) => init.secrets.set(SUPABASE_SESSION_KEY, sessionData),
    delete: () => init.secrets.delete(SUPABASE_SESSION_KEY),
  };
  const coordinator = new SupabaseSessionCoordinator({
    storage,
    getClient: () => SupabaseClient.getClient(),
    whenReady: init.whenReady ?? (async () => {}),
    tokenRefreshThresholdMs: TOKEN_REFRESH_THRESHOLD_MS,
    defaultSessionExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
    githubTokenRefreshUrl: GITHUB_TOKEN_REFRESH_URL,
    edgeFunctionTimeoutMs: DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS,
    log: init.log,
    onTokenExpiryChanged: (expiresAt) =>
      SupabaseClient.setTokenExpiry(expiresAt),
  });
  SupabaseClient.setAuthProvider(coordinator);
  return coordinator;
}
