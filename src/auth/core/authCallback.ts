const AUTH_CALLBACK_PATHS = [
  '/auth-callback',
  '/extension-auth-callback',
] as const;

export interface AuthCallbackUriParts {
  path: string;
  query?: string;
}

interface AuthCallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

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

/** Extract the PKCE authorization code or auth error from a callback query. */
export function parseAuthCallbackCode(
  uri: AuthCallbackUriParts,
): AuthCallbackCodeParseResult {
  const queryParams = new URLSearchParams(
    uri.query || getQueryFromPath(uri.path),
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

interface AuthCallbackCodeParseSuccess {
  success: true;
  code: string;
}

export type AuthCallbackCodeParseResult =
  AuthCallbackCodeParseSuccess | AuthCallbackParseError;
