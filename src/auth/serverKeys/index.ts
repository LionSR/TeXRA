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
import { SupabaseClient } from '../SupabaseClient';
import { getTierService } from '../tier';
import { ServerSideKeyService, type AuthProvider } from './ServerSideKeyService';

// Types
export { SERVER_SIDE_PROVIDERS, type ServerSideProvider } from './types';

// Service class
export { ServerSideKeyService, type AuthProvider };

// ==========================================================================
// Singleton Instance
// ==========================================================================

let _instance: ServerSideKeyService | null = null;

const defaultAuthProvider: AuthProvider = {
  isAuthenticated: () => SupabaseClient.isAuthenticated(),
  getUserTier: () => SupabaseClient.getUserTier(),
};

/**
 * Get the singleton ServerSideKeyService instance.
 */
export function getServerSideKeyService(): ServerSideKeyService {
  if (!_instance) {
    _instance = new ServerSideKeyService(
      `https://${SUPABASE_CUSTOM_DOMAIN}`,
      defaultAuthProvider,
      getTierService(),
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
 */
export function initializeServerSideKeyAccess(
  context: vscode.ExtensionContext,
): void {
  getServerSideKeyService().initialize(context);
}
