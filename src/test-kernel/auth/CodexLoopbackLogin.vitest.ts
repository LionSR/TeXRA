import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_CALLBACK_PATH,
  loginWithLoopback,
  type CodexAuthorizeRequest,
  type CodexSession,
  type CodexSessionCoordinator,
} from '@auth/codex';

function testSession(): CodexSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
  };
}

describe('Codex loopback login', () => {
  it('ignores stale callback errors and accepts a later valid callback', async () => {
    const state = 'expected-state';
    const verifier = 'verifier';
    const expectedSession = testSession();
    let request!: CodexAuthorizeRequest;
    const completeLoginWithCode = vi.fn(async () => expectedSession);
    const coordinator = {
      buildAuthorizeRequest: (port: number): CodexAuthorizeRequest => {
        const redirectUri = `http://localhost:${port}${CODEX_CALLBACK_PATH}`;
        const url = new URL('https://auth.example.test/oauth/authorize');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', state);
        request = {
          url: url.toString(),
          verifier,
          state,
          redirectUri,
        };
        return request;
      },
      completeLoginWithCode,
    } as unknown as CodexSessionCoordinator;

    const session = await loginWithLoopback({
      coordinator,
      openBrowser: async () => {
        const callback = new URL(request.redirectUri);
        callback.hostname = '127.0.0.1';

        callback.search = new URLSearchParams({
          state: 'stale-state',
          code: 'stale-code',
        }).toString();
        expect((await fetch(callback)).status).toBe(400);

        callback.search = new URLSearchParams({
          state,
          code: 'valid-code',
        }).toString();
        expect((await fetch(callback)).status).toBe(200);
      },
    });

    expect(session).toEqual(expectedSession);
    expect(completeLoginWithCode).toHaveBeenCalledWith({
      code: 'valid-code',
      verifier,
      redirectUri: request.redirectUri,
    });
  });
});
