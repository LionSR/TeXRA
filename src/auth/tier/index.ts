/**
 * Tier-based model access module.
 *
 * INTERNAL MODULE: This module is intended for use within the auth subsystem.
 * External consumers should use ServerSideKeyService from '@auth/serverKeys'
 * which provides a higher-level API and handles cache coordination.
 *
 * Provides TierService for managing tier configuration and model access.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER HIERARCHY (model access):
 * - free: input <= $1.5/M AND output <= $9/M
 * - Max: every model
 * - Ultra: every model
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import { TierService } from './TierService';
import type { AuthServiceLogger } from '../serviceLogger';

// Service class (internal use only)
export { TierService };

// ==========================================================================
// Singleton Instance
// ==========================================================================

let _instance: TierService | null = null;

/**
 * Get the singleton TierService instance.
 */
export function getTierService(logger?: AuthServiceLogger): TierService {
  if (!_instance) {
    _instance = new TierService(`https://${SUPABASE_CUSTOM_DOMAIN}`, logger);
  }
  return _instance;
}
