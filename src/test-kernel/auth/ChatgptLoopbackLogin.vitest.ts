// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import { chatgptLoginWithLoopback as loginWithLoopback } from '@texra-ai/llm/node';
import type { ChatgptSession } from '../../../packages/llm/src/oauth/chatgpt/chatgptProvider.js';
import type { SubscriptionAuthorizeRequest } from '../../../packages/llm/src/oauth/subscriptionCoordinator.js';

/** The callback path ChatGPT's sign-in returns to. */
const CALLBACK_PATH = '/auth/callback';

/** The login program with the HTTP client a host provides. */
const login = (options: Parameters<typeof loginWithLoopback>[0]) =>
  loginWithLoopback(options).pipe(Effect.provide(FetchHttpClient.layer));

// it.live throughout: the flow binds a real loopback socket on the ChatGPT
// callback port (or any free one), answers real fetches, and its callback
// wait sits under the live AUTH_CALLBACK_TIMEOUT_MS.
describe('ChatGPT loopback login', () => {
  it.live(
    'ignores stale callback errors and accepts a later valid callback',
    () =>
      Effect.gen(function* () {
        const state = 'expected-state';
        const verifier = 'verifier';
        const expectedSession: ChatgptSession = {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAtMs: Date.now() + 60_000,
        };
        let request: SubscriptionAuthorizeRequest | undefined;
        const loginWithCode = vi.fn(() => Effect.succeed(expectedSession));
        const coordinator: Parameters<typeof login>[0]['coordinator'] = {
          buildAuthorizeRequest: (port: number) => {
            const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
            const url = new URL('https://auth.example.test/oauth/authorize');
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            request = {
              url: url.toString(),
              verifier,
              state,
              nonce: 'nonce',
              redirectUri,
              clientId: 'dynamic_agent_client',
              registering: true,
            };
            return Effect.succeed(request);
          },
          loginWithCode,
        };

        const session = yield* login({
          coordinator,
          openBrowser: () =>
            Effect.promise(async () => {
              if (request === undefined) {
                throw new Error(
                  'The browser opened before the authorize request.',
                );
              }
              const callback = new URL(request.redirectUri);

              callback.search = new URLSearchParams({
                state: 'stale-state',
                code: 'stale-code',
              }).toString();
              expect((await fetch(callback)).status).toBe(400);

              callback.search = new URLSearchParams({
                state,
                code: 'valid-code',
                client_id: 'oaiapp_issued',
              }).toString();
              expect((await fetch(callback)).status).toBe(200);
            }),
        });

        expect(session).toEqual(expectedSession);
        // The client a registering sign-in was issued reaches the exchange.
        expect(loginWithCode).toHaveBeenCalledWith(request, {
          code: 'valid-code',
          clientId: 'oaiapp_issued',
        });
      }),
  );
});
