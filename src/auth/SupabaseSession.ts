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
    label: z.string(),
  }),
  expiresAt: z.number(),
  useCustomRefresh: z.boolean().optional(),
});
export type SupabaseSession = z.infer<typeof SupabaseSessionSchema>;

export interface SupabaseSessionParseOptions {
  logSource?: string;
  warn?: (source: string, message: string) => void;
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
      label: nativeSession.user.email || nativeSession.user.id,
    },
    expiresAt: nativeSession.expires_at
      ? nativeSession.expires_at * 1000
      : Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
    useCustomRefresh: options?.useCustomRefresh,
  };
}
