const AUTH_CALLBACK_PATHS = [
  '/auth-callback',
  '/extension-auth-callback',
] as const;

export interface AuthCallbackUriParts {
  path: string;
  query?: string;
}

interface AuthCallbackCodeParseSuccess {
  success: true;
  code: string;
}

interface AuthCallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

export type AuthCallbackCodeParseResult =
  AuthCallbackCodeParseSuccess | AuthCallbackParseError;

export function isAuthCallbackPath(path: string): boolean {
  return AUTH_CALLBACK_PATHS.includes(
    path.split('?')[0] as (typeof AUTH_CALLBACK_PATHS)[number],
  );
}

/** Extract the PKCE authorization code or auth error from a callback query. */
export function parseAuthCallbackCode(
  uri: AuthCallbackUriParts,
): AuthCallbackCodeParseResult {
  const queryStart = uri.path.indexOf('?');
  const queryParams = new URLSearchParams(
    uri.query || (queryStart === -1 ? '' : uri.path.slice(queryStart + 1)),
  );
  const getParam = (name: string): string | null => queryParams.get(name);

  const error = getParam('error');
  if (error) {
    return {
      success: false,
      error: getParam('error_description') || error,
      isAuthError: true,
    };
  }

  const code = getParam('code');
  return code
    ? { success: true, code }
    : { success: false, error: 'Missing authorization code in callback' };
}
