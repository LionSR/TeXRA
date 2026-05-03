export const AUTH_CALLBACK_PATHS = [
  '/auth-callback',
  '/extension-auth-callback',
] as const;

export interface AuthCallbackUriParts {
  path: string;
  query?: string;
  fragment?: string;
}

export interface AuthCallbackTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string | null;
}

export interface AuthCallbackTokenParseSuccess {
  success: true;
  tokens: AuthCallbackTokens;
}

export interface AuthCallbackTokenParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type AuthCallbackTokenParseResult =
  | AuthCallbackTokenParseSuccess
  | AuthCallbackTokenParseError;

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
 * Extract Supabase callback tokens or auth errors from host-neutral URI parts.
 * Fragment params win over query params, matching the implicit-flow callback.
 */
export function parseAuthCallbackTokens(
  uri: AuthCallbackUriParts,
): AuthCallbackTokenParseResult {
  const fragmentParams = new URLSearchParams(uri.fragment ?? '');
  const queryParams = new URLSearchParams(
    uri.query || getQueryFromPath(uri.path),
  );

  const getParam = (name: string): string | null =>
    fragmentParams.get(name) ?? queryParams.get(name);

  const accessToken = getParam('access_token');
  const refreshToken = getParam('refresh_token');
  const expiresIn = getParam('expires_in');
  const error = getParam('error');
  const errorDescription = getParam('error_description');

  if (error) {
    return {
      success: false,
      error: errorDescription || error,
      isAuthError: true,
    };
  }

  if (!accessToken || !refreshToken) {
    return {
      success: false,
      error: 'Missing tokens in callback',
    };
  }

  return {
    success: true,
    tokens: {
      accessToken,
      refreshToken,
      expiresIn,
    },
  };
}
