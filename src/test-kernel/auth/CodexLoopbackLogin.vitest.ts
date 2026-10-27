// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import { codexLoginWithLoopback as loginWithLoopback } from '@texra-ai/llm/node';
import type { CodexSession } from '../../../packages/llm/src/oauth/codex/codexProvider.js';
import type { SubscriptionOAuthCoordinator } from '../../../packages/llm/src/oauth/SubscriptionOAuthCoordinator.js';
import type { SubscriptionAuthorizeRequest } from '../../../packages/llm/src/oauth/subscriptionCoordinator.js';

/** The callback path ChatGPT's OAuth registration pins. */
const CALLBACK_PATH = '/auth/callback';

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
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
  };
}

function coordinatorStub(
  overrides: Record<string, unknown> = {},
): SubscriptionOAuthCoordinator<CodexSession> {
  return {
    buildAuthorizeRequest: loopbackRequest,
    ...overrides,
  } as unknown as SubscriptionOAuthCoordinator<CodexSession>;
}

/** The login program with the HTTP client a host provides. */
const login = (options: Parameters<typeof loginWithLoopback>[0]) =>
  loginWithLoopback(options).pipe(Effect.provide(FetchHttpClient.layer));

// it.live throughout: the flow binds a real loopback socket on the Codex
// callback port (or its fallback), answers real fetches, and its callback
// wait sits under the live AUTH_CALLBACK_TIMEOUT_MS.
describe('Codex loopback login', () => {
  it.live(
    'ignores stale callback errors and accepts a later valid callback',
    () =>
      Effect.gen(function* () {
        const state = 'expected-state';
        const verifier = 'verifier';
        const expectedSession = testSession();
        let request!: SubscriptionAuthorizeRequest;
        const loginWithCode = vi.fn(() => Effect.succeed(expectedSession));
        const coordinator = coordinatorStub({
          buildAuthorizeRequest: (
            port: number,
          ): SubscriptionAuthorizeRequest => {
            const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
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
          loginWithCode,
        });

        const session = yield* login({
          coordinator,
          openBrowser: () =>
            Effect.promise(async () => {
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
            }),
        });

        expect(session).toEqual(expectedSession);
        expect(loginWithCode).toHaveBeenCalledWith({
          code: 'valid-code',
          verifier,
          redirectUri: request.redirectUri,
        });
      }),
  );
});
