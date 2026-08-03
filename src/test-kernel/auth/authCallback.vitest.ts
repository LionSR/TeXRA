// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - auth
import {
  getAuthCallbackBasePath,
  isAuthCallbackPath,
  parseAuthCallbackCode,
} from '@auth/authCallback';

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
});

describe('parseAuthCallbackCode', () => {
  it('extracts the PKCE code from the query string', () => {
    assert.deepEqual(
      parseAuthCallbackCode({ path: '/auth-callback', query: 'code=abc123' }),
      { success: true, code: 'abc123' },
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
