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
 * - Max tier: Mid-tier models ($1-3/M) + all free tier models
 * - free tier: Budget models only (under $1/M input)
 */

import * as vscode from 'vscode';
import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import { getTierService } from '../tier';
import {
  ServerSideKeyService,
  type AuthProvider,
} from './ServerSideKeyService';

// Types
export { SERVER_SIDE_PROVIDERS, type ServerSideProvider } from './types';

// Service class
export { ServerSideKeyService, type AuthProvider };

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
 * @param context - VS Code extension context
 * @param authProvider - Provider for authentication state checks
 */
export function initializeServerSideKeyAccess(
  context: vscode.ExtensionContext,
  authProvider: AuthProvider,
): void {
  _instance = new ServerSideKeyService(
    `https://${SUPABASE_CUSTOM_DOMAIN}`,
    authProvider,
    getTierService(),
  );
  _instance.initialize({
    state: context.globalState,
    subscriptions: context.subscriptions,
  });
}
