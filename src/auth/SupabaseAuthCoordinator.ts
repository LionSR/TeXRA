import { toErrorMessage } from '@common/errors/errorMessage';

import {
  DEFAULT_SESSION_EXPIRY_MS,
  GITHUB_TOKEN_REFRESH_URL,
  SUPABASE_CONFIG,
  SUPABASE_SESSION_KEY,
  TOKEN_REFRESH_THRESHOLD_MS,
} from './config';
import { SupabaseClient } from './SupabaseClient';
import {
  SupabaseSessionCoordinator,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './SupabaseSession';

export const DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS = 30000;

export interface SupabaseSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SupabaseAuthCoordinatorOptions {
  storage: SupabaseSessionStorage;
  whenReady?: () => Promise<void>;
  log?: SupabaseSessionLog;
  edgeFunctionTimeoutMs?: number;
}

export function createSupabaseSessionStorage(
  secrets: SupabaseSecretStore,
  sessionKey = SUPABASE_SESSION_KEY,
): SupabaseSessionStorage {
  return {
    get: () => secrets.get(sessionKey),
    store: (sessionData) => secrets.set(sessionKey, sessionData),
    delete: () => secrets.delete(sessionKey),
  };
}

export function createSupabaseAuthCoordinator(
  options: SupabaseAuthCoordinatorOptions,
): SupabaseSessionCoordinator {
  try {
    SupabaseClient.initialize(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publicKey);
  } catch (error) {
    throw new Error(
      `Supabase authentication is not configured: ${toErrorMessage(error)}`,
    );
  }
  const coordinator = new SupabaseSessionCoordinator({
    storage: options.storage,
    getClient: () => SupabaseClient.getClient(),
    whenReady: options.whenReady ?? (async () => {}),
    tokenRefreshThresholdMs: TOKEN_REFRESH_THRESHOLD_MS,
    defaultSessionExpiryMs: DEFAULT_SESSION_EXPIRY_MS,
    githubTokenRefreshUrl: GITHUB_TOKEN_REFRESH_URL,
    edgeFunctionTimeoutMs:
      options.edgeFunctionTimeoutMs ?? DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS,
    log: options.log,
    onTokenExpiryChanged: (expiresAt) =>
      SupabaseClient.setTokenExpiry(expiresAt),
  });
  SupabaseClient.setAuthProvider(coordinator);
  return coordinator;
}
