import {
  createSupabaseAuthCoordinator,
  createSupabaseSessionStorage,
  type SupabaseSecretStore,
} from './SupabaseAuthCoordinator';
import type {
  SupabaseSessionCoordinator,
  SupabaseSessionLog,
} from './SupabaseSession';

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
  return createSupabaseAuthCoordinator({
    storage: createSupabaseSessionStorage(init.secrets),
    log: init.log,
    whenReady: init.whenReady,
  });
}
