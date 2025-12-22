/**
 * Type definitions for server-side API key access.
 */

import type { UserTier } from '../config';

/**
 * All providers that could potentially support server-side API keys.
 * The actual enabled providers are fetched from the relay server at runtime.
 */
export const SERVER_SIDE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;

export type ServerSideProvider = (typeof SERVER_SIDE_PROVIDERS)[number];

/** Cache state for enabled providers fetched from the relay server. */
export interface ProvidersCache {
  promise: Promise<string[]> | null;
  timestamp: number;
  /** Sync-accessible list of providers (populated when promise resolves). */
  providers: string[];
}

/** Cache state for server-side key access check. */
export interface AccessCache {
  promise: Promise<boolean> | null;
  timestamp: number;
  /** Sync-accessible result (populated when promise resolves). */
  lastKnownResult: boolean;
  /** The user's tier (for model-level access checks). */
  userTier: UserTier | null;
}
