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

import { appSignals } from '@eventBus/AppSignals';
import * as logger from '@logger/logUtils';
import { tryGlobalState } from '@platform/platform';
import { SUPABASE_CONFIG } from '../config';
import { TierService } from './TierService';
import { ServerSideKeyService } from './ServerSideKeyService';

// Service class
export { ServerSideKeyService };

// ==========================================================================
// Singleton Instance
// ==========================================================================

let _instance: ServerSideKeyService | null = null;

/**
 * True when `_instance` was built before `initPlatform()` ran (no state
 * store). Such an instance permanently forces included access off, so if the
 * platform state store appears later we rebuild rather than serving the
 * stateless zombie forever. Embedders that never init a platform keep the
 * stateless instance — `tryGlobalState()` stays null for them.
 */
let _constructedStateless = false;

/**
 * Get the singleton ServerSideKeyService instance, constructing it on first
 * use. There is no host bootstrap step: state comes from the platform and the
 * toggle change signal goes onto `appSignals`, both of which every host
 * already owns.
 *
 * An embedder that never calls `initPlatform()` still gets a usable service —
 * with included (relay) model access forced off, since without a state store
 * the preference can neither be read nor surfaced. See the
 * `ServerSideKeyService` constructor.
 */
export function getServerSideKeyService(): ServerSideKeyService {
  const state = tryGlobalState();
  if (_instance && !(_constructedStateless && state)) return _instance;

  if (!state) {
    logger.warn(
      'ServerSideKeyService',
      'No platform state store; included model access is off for this ' +
        'process. Call initPlatform() before the first model call to use ' +
        'relay access, or configure a provider API key.',
    );
  }

  const baseUrl = SUPABASE_CONFIG.url;
  _instance = new ServerSideKeyService(
    baseUrl,
    new TierService(baseUrl, logger),
    state,
    logger,
    (enabled) => appSignals.emit('includedModelAccessChanged', enabled),
  );
  _constructedStateless = !state;
  return _instance;
}

/**
 * Set a custom ServerSideKeyService instance (for testing).
 */
export function setServerSideKeyService(service: ServerSideKeyService): void {
  _instance = service;
  // Injected instances are authoritative — never rebuild them out from under
  // a test just because a platform state store appears later.
  _constructedStateless = false;
}

/** Reset singleton state between unit tests. */
export function resetServerSideKeyServiceForTests(): void {
  _instance = null;
  _constructedStateless = false;
}
