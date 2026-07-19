/**
 * Server-side API key access module.
 *
 * Provides ServerSideKeyService for managing server-side API key access.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER-BASED ACCESS (cumulative):
 * - Ultra tier: Access to ALL models via relay (full access)
 * - Max tier: Free-tier models plus any future Max-only additions
 * - free tier: Included non-premium models (up to $3/M input)
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import { getTierService } from '../tier';
import { ServerSideKeyService } from './ServerSideKeyService';
import type { SupabaseSessionLog } from '../supabaseSessionTypes';
import type { StateStore } from '@platform/interfaces';

// Types
export { SERVER_SIDE_PROVIDERS, type ServerSideProvider } from './types';

// Service class
export { ServerSideKeyService };

// ==========================================================================
// Singleton Instance
// ==========================================================================

let _instance: ServerSideKeyService | null = null;

/**
 * Get the singleton ServerSideKeyService instance.
 * Throws if not initialized - call initializeServerSideKeyAccess() first.
 */
export function getServerSideKeyService(): ServerSideKeyService {
  if (!_instance) {
    throw new Error(
      'ServerSideKeyService not initialized. Call initializeServerSideKeyAccess() first.',
    );
  }
  return _instance;
}

/**
 * Set a custom ServerSideKeyService instance (for testing).
 */
export function setServerSideKeyService(service: ServerSideKeyService): void {
  _instance = service;
}

/**
 * Initialize the server-side key access module.
 * Call this during extension activation.
 *
 * @param options - Host-provided state and logger
 */
export function initializeServerSideKeyAccess(options: {
  state?: StateStore;
  logger?: SupabaseSessionLog;
  notifyIncludedModelAccessChanged?: (enabled: boolean) => void;
}): void {
  _instance = new ServerSideKeyService(
    `https://${SUPABASE_CUSTOM_DOMAIN}`,
    getTierService(options.logger),
    options.state ?? null,
    options.logger,
    options.notifyIncludedModelAccessChanged,
  );
}
