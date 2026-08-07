import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_CALLBACK_PATH,
  loginWithLoopback,
  type CodexSession,
  type CodexSessionCoordinator,
} from '@auth/codex';
import type { SubscriptionAuthorizeRequest } from '@auth/oauth/SubscriptionOAuthCoordinator';

function testSession(): CodexSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
  };
}

function loopbackRequest(port: number): SubscriptionAuthorizeRequest {
  return {
    url: 'https://auth.example.test/oauth/authorize',
    verifier: 'verifier',
    state: 'state',
    redirectUri: `http://127.0.0.1:${port}${CODEX_CALLBACK_PATH}`,
  };
}

function coordinatorStub(
  overrides: Record<string, unknown> = {},
): CodexSessionCoordinator {
  return {
    buildAuthorizeRequest: loopbackRequest,
    ...overrides,
  } as unknown as CodexSessionCoordinator;
}

describe('Codex loopback login', () => {
  it('closes the callback wait when its host cancels', async () => {
    const controller = new AbortController();
    const completion = loginWithLoopback({
      coordinator: coordinatorStub(),
      openBrowser: () => controller.abort(),
      signal: controller.signal,
    });

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('settles cancellation while the browser launcher remains pending', async () => {
    const controller = new AbortController();
    let finishBrowserLaunch!: () => void;
    const completion = loginWithLoopback({
      coordinator: coordinatorStub(),
      openBrowser: () =>
        new Promise<void>((resolve) => {
          finishBrowserLaunch = resolve;
        }),
      signal: controller.signal,
    });
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });

    controller.abort();

    await rejection;
    finishBrowserLaunch();
  });

  it('does not exchange a code when cancellation follows its callback', async () => {
    const controller = new AbortController();
    let request!: SubscriptionAuthorizeRequest;
    const completeLoginWithCode = vi.fn();
    const completion = loginWithLoopback({
      coordinator: coordinatorStub({
        buildAuthorizeRequest: (port: number): SubscriptionAuthorizeRequest => {
          request = loopbackRequest(port);
          return request;
        },
        completeLoginWithCode,
      }),
      openBrowser: async () => {
        const callback = new URL(request.redirectUri);
        callback.searchParams.set('state', request.state);
        callback.searchParams.set('code', 'authorization-code');
        await fetch(callback);
        controller.abort();
      },
      signal: controller.signal,
    });

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(completeLoginWithCode).not.toHaveBeenCalled();
  });

  it('ignores stale callback errors and accepts a later valid callback', async () => {
    const state = 'expected-state';
    const verifier = 'verifier';
    const expectedSession = testSession();
    let request!: SubscriptionAuthorizeRequest;
    const completeLoginWithCode = vi.fn(async () => expectedSession);
    const coordinator = coordinatorStub({
      buildAuthorizeRequest: (port: number): SubscriptionAuthorizeRequest => {
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
    });

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
