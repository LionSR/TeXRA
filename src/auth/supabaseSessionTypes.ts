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
  /**
   * Present only on sessions stored before VS Code GitHub sign-in moved to
   * native GoTrue sessions; no sign-in flow sets it today. It keeps those
   * sessions refreshing through the custom endpoint rather than forcing a
   * re-sign-in.
   */
  useCustomRefresh: z.boolean().optional(),
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

function firstAccountLabel(
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
  log?: SupabaseSessionLog,
): Promise<GitHubTokenExchangeResponse> {
  const rawData = await response.json();
  const parsed = GitHubTokenExchangeSchema.safeParse(rawData);
  if (!parsed.success) {
    log?.error?.(
      'SupabaseSession',
      `Token exchange response validation failed: ${z.prettifyError(parsed.error)}`,
    );
    throw new Error('Invalid response format from authentication server');
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
  defaultExpiryMs: number,
): number {
  if (expiresAtSeconds) return expiresAtSeconds * 1000;
  if (expiresInSeconds) return Date.now() + expiresInSeconds * 1000;
  return Date.now() + defaultExpiryMs;
}

/**
 * Convert Supabase's native session-shaped responses to our storage format.
 * Handles the snake_case to camelCase and seconds to milliseconds conversions.
 */
export function toStorableSupabaseSession(
  nativeSession: StorableSessionInput,
  options?: {
    fallbackLabel?: string;
    defaultExpiryMs?: number;
    useCustomRefresh?: boolean;
  },
): SupabaseSession {
  return {
    id: nativeSession.user.id,
    accessToken: nativeSession.access_token,
    refreshToken: nativeSession.refresh_token,
    account: {
      id: nativeSession.user.id,
      label: firstAccountLabel(
        nativeSession.user.email,
        options?.fallbackLabel,
        nativeSession.user.id,
      ),
    },
    expiresAt: resolveExpiresAt(
      nativeSession.expires_at,
      nativeSession.expires_in,
      options?.defaultExpiryMs ?? DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
    ),
    ...(options?.useCustomRefresh === undefined
      ? {}
      : { useCustomRefresh: options.useCustomRefresh }),
  };
}
