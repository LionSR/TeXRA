const AUTH_CALLBACK_PATHS = [
  '/auth-callback',
  '/extension-auth-callback',
] as const;

export interface AuthCallbackUriParts {
  path: string;
  query?: string;
  fragment?: string;
}

interface AuthCallbackTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string | null;
}

interface AuthCallbackTokenParseSuccess {
  success: true;
  tokens: AuthCallbackTokens;
}

interface AuthCallbackTokenParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type AuthCallbackTokenParseResult =
  AuthCallbackTokenParseSuccess | AuthCallbackTokenParseError;

export function getAuthCallbackBasePath(path: string): string {
  return path.split('?')[0];
}

export function isAuthCallbackPath(path: string): boolean {
  return AUTH_CALLBACK_PATHS.includes(
    getAuthCallbackBasePath(path) as (typeof AUTH_CALLBACK_PATHS)[number],
  );
}

function getQueryFromPath(path: string): string {
  const queryStart = path.indexOf('?');
  return queryStart === -1 ? '' : path.slice(queryStart + 1);
}

/**
 * Read a callback URI's params and surface any auth error it carries.
 *
 * `priority` selects which source wins when a name appears in both the fragment
 * and the query: implicit-flow token callbacks prefer the fragment, PKCE code
 * callbacks prefer the query.
 */
function readCallbackParams(
  uri: AuthCallbackUriParts,
  priority: 'fragment' | 'query',
): {
  getParam: (name: string) => string | null;
  authError: AuthCallbackTokenParseError | null;
} {
  const fragmentParams = new URLSearchParams(uri.fragment ?? '');
  const queryParams = new URLSearchParams(
    uri.query || getQueryFromPath(uri.path),
  );
  const sources =
    priority === 'fragment'
      ? [fragmentParams, queryParams]
      : [queryParams, fragmentParams];

  const getParam = (name: string): string | null => {
    for (const source of sources) {
      const value = source.get(name);
      if (value !== null) return value;
    }
    return null;
  };

  const error = getParam('error');
  const authError: AuthCallbackTokenParseError | null = error
    ? {
        success: false,
        error: getParam('error_description') || error,
        isAuthError: true,
      }
    : null;

  return { getParam, authError };
}

/**
 * Extract Supabase callback tokens or auth errors from host-neutral URI parts.
 * Fragment params win over query params, matching the legacy implicit-flow
 * callback. PKCE callbacks use parseAuthCallbackCode instead.
 */
export function parseAuthCallbackTokens(
  uri: AuthCallbackUriParts,
): AuthCallbackTokenParseResult {
  const { getParam, authError } = readCallbackParams(uri, 'fragment');
  if (authError) return authError;

  const accessToken = getParam('access_token');
  const refreshToken = getParam('refresh_token');
  if (!accessToken || !refreshToken) {
    return { success: false, error: 'Missing tokens in callback' };
  }

  return {
    success: true,
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: getParam('expires_in'),
    },
  };
}

interface AuthCallbackCodeParseSuccess {
  success: true;
  code: string;
}

export type AuthCallbackCodeParseResult =
  AuthCallbackCodeParseSuccess | AuthCallbackTokenParseError;

/**
 * Extract the PKCE authorization code (or an auth error) from host-neutral URI
 * parts. The code arrives in the query string for the PKCE flow, so query wins
 * here, with the fragment as a defensive fallback.
 */
export function parseAuthCallbackCode(
  uri: AuthCallbackUriParts,
): AuthCallbackCodeParseResult {
  const { getParam, authError } = readCallbackParams(uri, 'query');
  if (authError) return authError;

  const code = getParam('code');
  if (!code) {
    return { success: false, error: 'Missing authorization code in callback' };
  }

  return { success: true, code };
}
