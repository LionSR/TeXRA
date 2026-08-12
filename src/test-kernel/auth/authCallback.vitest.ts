import { describe, expect, it } from 'vitest';

import {
  getAuthCallbackBasePath,
  isAuthCallbackPath,
  parseAuthCallbackCode,
} from '@auth/authCallback';

describe('authCallback', () => {
  it('recognizes desktop and web callback paths', () => {
    expect(isAuthCallbackPath('/auth-callback')).toBe(true);
    expect(isAuthCallbackPath('/extension-auth-callback')).toBe(true);
    expect(
      isAuthCallbackPath('/extension-auth-callback?state=vscode-state'),
    ).toBe(true);
    expect(isAuthCallbackPath('/not-auth')).toBe(false);
    expect(getAuthCallbackBasePath('/extension-auth-callback?state=abc')).toBe(
      '/extension-auth-callback',
    );
  });

  it('extracts the PKCE code from the query string', () => {
    expect(
      parseAuthCallbackCode({ path: '/auth-callback', query: 'code=abc123' }),
    ).toEqual({ success: true, code: 'abc123' });
  });

  it('reports auth errors before looking for a code', () => {
    expect(
      parseAuthCallbackCode({
        path: '/auth-callback',
        query: 'error=access_denied&error_description=Nope',
      }),
    ).toEqual({ success: false, error: 'Nope', isAuthError: true });
  });

  it('reports a missing code', () => {
    expect(parseAuthCallbackCode({ path: '/auth-callback' })).toEqual({
      success: false,
      error: 'Missing authorization code in callback',
    });
  });
});
