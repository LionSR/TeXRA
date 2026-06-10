import { z } from 'zod';
import { toErrorMessage } from '@common/errors/errorMessage';
import type { Session as SupabaseNativeSession } from '@supabase/supabase-js';

export const DEFAULT_SUPABASE_SESSION_EXPIRY_MS = 60 * 60 * 1000;

export const SupabaseSessionSchema = z.object({
  id: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  account: z.object({
    id: z.string(),
    label: z.string().transform((label) => label.trim()),
  }),
  expiresAt: z.number(),
  useCustomRefresh: z.boolean().optional(),
});
export type SupabaseSession = z.infer<typeof SupabaseSessionSchema>;

/** Response schema for GitHub token exchange and refresh Edge Functions. */
export const GitHubTokenExchangeSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().optional(),
  expires_in: z.number().optional(),
  token_type: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().nullish(),
    user_metadata: z
      .object({
        avatar_url: z.string().optional(),
        user_name: z.string().optional(),
      })
      .optional(),
  }),
});
export type GitHubTokenExchangeResponse = z.infer<
  typeof GitHubTokenExchangeSchema
>;

export interface SupabaseSessionParseOptions {
  logSource?: string;
  warn?: (source: string, message: string) => void;
}

/** Storage boundary for persisted Supabase session data. */
export interface SupabaseSessionStorage {
  get(): Promise<string | undefined>;
  store(sessionData: string): Promise<void>;
  delete(): Promise<void>;
}

export interface SupabaseSessionLog {
  debug?(source: string, message: string): void;
  info?(source: string, message: string): void;
  warn?(source: string, message: string): void;
  error?(source: string, message: string): void;
}

/** Result of converting an auth callback into a stored session. */
export interface SupabaseCallbackParseResult {
  success: true;
  session: SupabaseSession;
}

export interface SupabaseCallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type SupabaseCallbackResult =
  | SupabaseCallbackParseResult
  | SupabaseCallbackParseError;

export function firstAccountLabel(
  ...candidates: readonly (string | null | undefined)[]
): string {
  for (const candidate of candidates) {
    const label = candidate?.trim();
    if (label) return label;
  }
  return 'unknown';
}

/**
 * Parse and validate stored session data.
 * Returns null if session data is missing or invalid.
 * Logs warnings for corrupted data to help diagnose auth issues.
 */
export function parseStoredSupabaseSession(
  sessionData: string | undefined,
  options?: SupabaseSessionParseOptions,
): SupabaseSession | null {
  if (!sessionData) return null;
  const logSource = options?.logSource ?? 'SupabaseSession';
  try {
    const parsed = SupabaseSessionSchema.safeParse(JSON.parse(sessionData));
    if (!parsed.success) {
      options?.warn?.(
        logSource,
        `Stored session has invalid schema: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  } catch (error) {
    options?.warn?.(
      logSource,
      `Failed to parse stored session: ${toErrorMessage(error)}`,
    );
    return null;
  }
}

export async function parseTokenExchangeResponse(
  response: Response,
  log?: SupabaseSessionLog,
): Promise<GitHubTokenExchangeResponse> {
  const rawData = await response.json();
  const parsed = GitHubTokenExchangeSchema.safeParse(rawData);
  if (!parsed.success) {
    log?.error?.(
      'SupabaseSession',
      `Token exchange response validation failed: ${parsed.error.message}`,
    );
    throw new Error('Invalid response format from authentication server');
  }
  return parsed.data;
}

/**
 * Convert Supabase's native Session to our storage format.
 * Handles the snake_case to camelCase and seconds to milliseconds conversions.
 */
export function toStorableSupabaseSession(
  nativeSession: SupabaseNativeSession,
  options?: { useCustomRefresh?: boolean },
): SupabaseSession {
  return {
    id: nativeSession.user.id,
    accessToken: nativeSession.access_token,
    refreshToken: nativeSession.refresh_token,
    account: {
      id: nativeSession.user.id,
      label: firstAccountLabel(nativeSession.user.email, nativeSession.user.id),
    },
    expiresAt: nativeSession.expires_at
      ? nativeSession.expires_at * 1000
      : Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
    useCustomRefresh: options?.useCustomRefresh,
  };
}

/** Convert Edge Function token responses into the stored custom-refresh shape. */
export function toStorableGitHubTokenExchangeSession(
  data: GitHubTokenExchangeResponse,
  fallbackLabel: string,
  defaultSessionExpiryMs: number,
): SupabaseSession {
  return {
    id: data.user.id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    account: {
      id: data.user.id,
      label: firstAccountLabel(data.user.email, fallbackLabel, data.user.id),
    },
    expiresAt: data.expires_at
      ? data.expires_at * 1000
      : Date.now() + defaultSessionExpiryMs,
    useCustomRefresh: true,
  };
}
