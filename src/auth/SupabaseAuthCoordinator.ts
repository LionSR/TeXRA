import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  SUPABASE_CONFIG,
  SUPABASE_SESSION_KEY,
  TOKEN_REFRESH_THRESHOLD_MS,
} from './config';
import {
  secretBackedSessionStorage,
  type SessionSecretStore,
} from './oauth/sessionAccess';
import { SupabaseClient } from './SupabaseClient';
import {
  SupabaseSessionCoordinator,
  type SupabaseSessionLog,
} from './SupabaseSession';

export interface HostAuthCoordinatorInit {
  readonly secrets: SessionSecretStore;
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
    SupabaseClient.initialize(
      SUPABASE_CONFIG.url,
      SUPABASE_CONFIG.publicKey,
      init.secrets,
    );
  } catch (error) {
    throw new Error(
      `Supabase authentication is not configured: ${toErrorMessage(error)}`,
    );
  }
  const storage = secretBackedSessionStorage(
    init.secrets,
    SUPABASE_SESSION_KEY,
  );
  const coordinator = new SupabaseSessionCoordinator({
    storage,
    getClient: () => SupabaseClient.getClient(),
    whenReady: init.whenReady ?? (async () => {}),
    tokenRefreshThresholdMs: TOKEN_REFRESH_THRESHOLD_MS,
    log: init.log,
  });
  SupabaseClient.setAuthProvider(coordinator);
  return coordinator;
}
