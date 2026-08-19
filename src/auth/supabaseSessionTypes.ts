import { z } from 'zod';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { toErrorMessage } from '@utils/errors/errorMessage';

export const DEFAULT_SUPABASE_SESSION_EXPIRY_MS = 60 * 60 * 1000;

const SupabaseSessionSchema = z.object({
  id: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  account: z.object({
    id: z.string(),
    label: z.string().transform((label) => label.trim()),
  }),
  expiresAt: z.number(),
});
export type SupabaseSession = z.infer<typeof SupabaseSessionSchema>;

/** Response schema for GitHub token exchange and refresh Edge Functions. */
const GitHubTokenExchangeSchema = z.object({
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
  debug?(source: string, message: string, options?: { data?: unknown }): void;
  info?(source: string, message: string, options?: { data?: unknown }): void;
  warn?(source: string, message: string, options?: { data?: unknown }): void;
  error?(source: string, message: string, options?: { data?: unknown }): void;
}

/** Result of converting an auth callback into a stored session. */
interface SupabaseCallbackParseResult {
  success: true;
  session: SupabaseSession;
}

interface SupabaseCallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type SupabaseCallbackResult =
  SupabaseCallbackParseResult | SupabaseCallbackParseError;

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
  const parsedJson = safeParseJson(sessionData);
  if (parsedJson.isErr()) {
    options?.warn?.(
      logSource,
      `Failed to parse stored session: ${toErrorMessage(parsedJson.error)}`,
    );
    return null;
  }
  const parsed = SupabaseSessionSchema.safeParse(parsedJson.value);
  if (!parsed.success) {
    options?.warn?.(
      logSource,
      `Stored session has invalid schema: ${z.prettifyError(parsed.error)}`,
    );
    return null;
  }
  return parsed.data;
}

export async function parseTokenExchangeResponse(
  response: Response,
): Promise<GitHubTokenExchangeResponse> {
  const rawData = await response.json();
  const parsed = GitHubTokenExchangeSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new Error(
      `Invalid response format from authentication server: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

type StorableSessionInput = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  user: {
    id: string;
    email?: string | null;
  };
};

/** Resolve a session expiry (ms epoch) from native `expires_at`/`expires_in`. */
function resolveExpiresAt(
  expiresAtSeconds: number | undefined,
  expiresInSeconds: number | undefined,
): number {
  if (expiresAtSeconds) return expiresAtSeconds * 1000;
  if (expiresInSeconds) return Date.now() + expiresInSeconds * 1000;
  return Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS;
}

/**
 * Convert Supabase's native session-shaped responses to our storage format.
 * Handles the snake_case to camelCase and seconds to milliseconds conversions.
 */
export function toStorableSupabaseSession(
  nativeSession: StorableSessionInput,
): SupabaseSession {
  return {
    id: nativeSession.user.id,
    accessToken: nativeSession.access_token,
    refreshToken: nativeSession.refresh_token,
    account: {
      id: nativeSession.user.id,
      label: nativeSession.user.email?.trim() || nativeSession.user.id,
    },
    expiresAt: resolveExpiresAt(
      nativeSession.expires_at,
      nativeSession.expires_in,
    ),
  };
}
