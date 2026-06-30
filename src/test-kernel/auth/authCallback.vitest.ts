// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - auth
import {
  getAuthCallbackBasePath,
  isAuthCallbackPath,
  parseAuthCallbackCode,
  parseAuthCallbackTokens,
} from '@auth/core/authCallback';

describe('authCallback', () => {
  it('recognizes desktop and web callback paths', () => {
    assert.equal(isAuthCallbackPath('/auth-callback'), true);
    assert.equal(isAuthCallbackPath('/extension-auth-callback'), true);
    assert.equal(
      isAuthCallbackPath('/extension-auth-callback?state=vscode-state'),
      true,
    );
    assert.equal(isAuthCallbackPath('/not-auth'), false);
    assert.equal(
      getAuthCallbackBasePath('/extension-auth-callback?state=abc'),
      '/extension-auth-callback',
    );
  });

  it('extracts tokens from fragment params before query params', () => {
    const result = parseAuthCallbackTokens({
      path: '/auth-callback',
      query: 'access_token=query-access&refresh_token=query-refresh',
      fragment:
        'access_token=fragment-access&refresh_token=fragment-refresh&expires_in=3600',
    });

    assert.deepEqual(result, {
      success: true,
      tokens: {
        accessToken: 'fragment-access',
        refreshToken: 'fragment-refresh',
        expiresIn: '3600',
      },
    });
  });

  it('preserves empty fragment params instead of falling back to query', () => {
    const result = parseAuthCallbackTokens({
      path: '/auth-callback',
      query: 'access_token=query-access&refresh_token=query-refresh',
      fragment: 'access_token=&refresh_token=fragment-refresh',
    });

    assert.deepEqual(result, {
      success: false,
      error: 'Missing tokens in callback',
    });
  });

  it('extracts tokens from query params when no fragment tokens exist', () => {
    const result = parseAuthCallbackTokens({
      path: '/auth-callback',
      query: 'access_token=query-access&refresh_token=query-refresh',
    });

    assert.deepEqual(result, {
      success: true,
      tokens: {
        accessToken: 'query-access',
        refreshToken: 'query-refresh',
        expiresIn: null,
      },
    });
  });

  it('extracts query params embedded in the path fallback', () => {
    const result = parseAuthCallbackTokens({
      path: '/extension-auth-callback?access_token=access&refresh_token=refresh',
    });

    assert.deepEqual(result, {
      success: true,
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: null,
      },
    });
  });

  it('reports auth errors and missing tokens', () => {
    assert.deepEqual(
      parseAuthCallbackTokens({
        path: '/auth-callback',
        fragment: 'error=access_denied&error_description=Nope',
      }),
      {
        success: false,
        error: 'Nope',
        isAuthError: true,
      },
    );

    assert.deepEqual(parseAuthCallbackTokens({ path: '/auth-callback' }), {
      success: false,
      error: 'Missing tokens in callback',
    });
  });
});

describe('parseAuthCallbackCode', () => {
  it('extracts the PKCE code from the query string', () => {
    assert.deepEqual(
      parseAuthCallbackCode({ path: '/auth-callback', query: 'code=abc123' }),
      { success: true, code: 'abc123' },
    );
  });

  it('falls back to the fragment when the query has no code', () => {
    assert.deepEqual(
      parseAuthCallbackCode({
        path: '/auth-callback',
        fragment: 'code=frag-code',
      }),
      { success: true, code: 'frag-code' },
    );
  });

  it('prefers the query code over a fragment code', () => {
    assert.deepEqual(
      parseAuthCallbackCode({
        path: '/auth-callback',
        query: 'code=query-code',
        fragment: 'code=fragment-code',
      }),
      { success: true, code: 'query-code' },
    );
  });

  it('reports auth errors before looking for a code', () => {
    assert.deepEqual(
      parseAuthCallbackCode({
        path: '/auth-callback',
        query: 'error=access_denied&error_description=Nope',
      }),
      { success: false, error: 'Nope', isAuthError: true },
    );
  });

  it('reports a missing code', () => {
    assert.deepEqual(parseAuthCallbackCode({ path: '/auth-callback' }), {
      success: false,
      error: 'Missing authorization code in callback',
    });
  });
});
