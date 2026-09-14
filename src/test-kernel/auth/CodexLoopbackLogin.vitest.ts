// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import { loginWithLoopback } from '@auth/codex';
import { CODEX_CALLBACK_PATH } from '@auth/codex/codexConstants';
import type { CodexSessionCoordinator } from '@auth/codex/CodexSessionCoordinator';
import type { CodexSession } from '@auth/codex/codexSessionTypes';
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

/** The login program with the HTTP client a host provides. */
const login = (options: Parameters<typeof loginWithLoopback>[0]) =>
  loginWithLoopback(options).pipe(Effect.provide(FetchHttpClient.layer));

// it.live throughout: the flow binds a real loopback socket on the Codex
// callback port (or its fallback), answers real fetches, and its callback
// wait sits under the live AUTH_CALLBACK_TIMEOUT_MS.
describe('Codex loopback login', () => {
  it.live('closes the callback wait when its host cancels', () =>
    Effect.gen(function* () {
      // The host cancels from inside the launcher, as `controller.abort()`
      // did: synchronously, inside the uninterruptible setup prefix.
      const host: { fiber?: Fiber.Fiber<CodexSession, unknown> } = {};
      const fiber = yield* Effect.forkChild(
        login({
          coordinator: coordinatorStub(),
          openBrowser: () => {
            host.fiber?.interruptUnsafe();
          },
        }),
      );
      host.fiber = fiber;

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }),
  );

  it.live(
    'settles cancellation while the browser launcher remains pending',
    () =>
      Effect.gen(function* () {
        let finishBrowserLaunch!: () => void;
        // startImmediately is load-bearing: the fiber has to reach the
        // uninterruptible setup before the interrupt, so the launcher is
        // still invoked and the interrupt lands at the launcher join.
        const fiber = yield* Effect.forkChild(
          login({
            coordinator: coordinatorStub(),
            openBrowser: () =>
              new Promise<void>((resolve) => {
                finishBrowserLaunch = resolve;
              }),
          }),
          { startImmediately: true },
        );

        yield* Fiber.interrupt(fiber);

        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        finishBrowserLaunch();
      }),
  );

  it.live(
    'does not exchange a code when cancellation follows its callback',
    () =>
      Effect.gen(function* () {
        let request!: SubscriptionAuthorizeRequest;
        const loginWithCode = vi.fn();
        const delivered = yield* Deferred.make<void>();
        let releaseLauncher!: () => void;
        // Holding the launcher pins the login fiber at the interruptible
        // launcher join, so the interrupt lands before the code exchange
        // can be reached.
        const launcherHeld = new Promise<void>((resolve) => {
          releaseLauncher = resolve;
        });
        const fiber = yield* Effect.forkChild(
          login({
            coordinator: coordinatorStub({
              buildAuthorizeRequest: (
                port: number,
              ): SubscriptionAuthorizeRequest => {
                request = loopbackRequest(port);
                return request;
              },
              loginWithCode,
            }),
            openBrowser: async () => {
              const callback = new URL(request.redirectUri);
              callback.searchParams.set('state', request.state);
              callback.searchParams.set('code', 'authorization-code');
              await fetch(callback);
              Deferred.doneUnsafe(delivered, Effect.void);
              await launcherHeld;
            },
          }),
        );

        yield* Deferred.await(delivered);
        yield* Fiber.interrupt(fiber);
        releaseLauncher();

        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        expect(loginWithCode).not.toHaveBeenCalled();
      }),
  );

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
          loginWithCode,
        });

        const session = yield* login({
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
        expect(loginWithCode).toHaveBeenCalledWith({
          code: 'valid-code',
          verifier,
          redirectUri: request.redirectUri,
        });
      }),
  );
});
