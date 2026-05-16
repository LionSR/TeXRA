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
  /**
   * Secret storage backing the persisted Supabase session.
   * VS Code passes a `context.secrets`-backed adapter; CLI and Electron pass
   * their `PlatformSecrets` implementation directly.
   */
  readonly secrets: SupabaseSecretStore;
  /** Optional structured log sink for the session coordinator. */
  readonly log?: SupabaseSessionLog;
  /**
   * Optional gate the coordinator awaits before processing OAuth callbacks.
   * The VS Code host uses this to ensure the URI handler is installed.
   */
  readonly whenReady?: () => Promise<void>;
}

/**
 * Shared host wiring for the Supabase session coordinator.
 *
 * All three TeXRA hosts (CLI, Electron, VS Code extension) build the same
 * coordinator from a secret store + log; this helper centralises that
 * construction so host-specific files only deal with their OAuth glue.
 */
export function createHostAuthCoordinator(
  init: HostAuthCoordinatorInit,
): SupabaseSessionCoordinator {
  return createSupabaseAuthCoordinator({
    storage: createSupabaseSessionStorage(init.secrets),
    log: init.log,
    whenReady: init.whenReady,
  });
}
