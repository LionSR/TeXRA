/**
 * Tier-based model access module.
 *
 * Provides TierService for managing tier configuration and model access.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER HIERARCHY (cumulative access):
 * - free: Budget models only (under $1/M input)
 * - Max: Mid-tier models ($1-3/M) + all free tier models
 * - Ultra: All models including premium ($3+/M input)
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import { TierService } from './TierService';

// Types
export {
  TierAccessConfigSchema,
  TierModelConfigSchema,
  type TierAccessConfig,
  type TierModelConfig,
  type UserTier,
} from './types';

// Service class
export { TierService };

// ==========================================================================
// Singleton Instance
// ==========================================================================

let _instance: TierService | null = null;

/**
 * Get the singleton TierService instance.
 */
export function getTierService(): TierService {
  if (!_instance) {
    _instance = new TierService(`https://${SUPABASE_CUSTOM_DOMAIN}`);
  }
  return _instance;
}

/**
 * Set a custom TierService instance (for testing).
 */
export function setTierService(service: TierService): void {
  _instance = service;
}
