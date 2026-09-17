import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { TestClock } from 'effect/testing';
import { describe, expect, vi } from 'vitest';

import type { CodexSessionCoordinator } from '@auth/codex/CodexSessionCoordinator';
import { loginWithDeviceCode } from '@auth/codex/codexDeviceLogin';
import {
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
} from '@auth/codex/codexConstants';
import { createDeferred } from '@test/support/asyncTestUtils';
import { jsonResponse } from '@test/support/fetchTestUtils';

/**
 * Drive the flow through the wire: the usercode endpoint answers once, and
 * every token poll goes to `onPoll`. The fetch is handed to the flow through
 * the `FetchHttpClient.Fetch` reference rather than installed on the global,
 * so nothing here depends on test ordering.
 */
function deviceEndpointsFetch(
  userCode: Record<string, unknown>,
  onPoll: (init: RequestInit | undefined) => Promise<Response>,
): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (String(url) === CODEX_DEVICE_USERCODE_URL) {
      expect(new Headers(init?.headers).get('content-type')).toBe(
        'application/json',
      );
      return jsonResponse({
        device_auth_id: 'device-auth-id',
        user_code: 'ABCD-EFGH',
        interval: 5,
        ...userCode,
      });
    }
    if (String(url) === CODEX_DEVICE_TOKEN_URL) return onPoll(init);
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function coordinatorStub(): CodexSessionCoordinator {
  return { completeDeviceLogin: vi.fn() } as unknown as CodexSessionCoordinator;
}

/** Let the flow's fiber cross its pending `fetch` promises and reach its next wait. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

describe('Codex device login', () => {
  it.effect(
    'does not exchange a token when interruption lands during a poll',
    () =>
      Effect.gen(function* () {
        const inFlight = createDeferred<Response>();
        const fetchMock = deviceEndpointsFetch({}, () => inFlight.promise);
        const coordinator = coordinatorStub();
        const shown = yield* Deferred.make<void>();
        const onPrompt = vi.fn(() => {
          Deferred.doneUnsafe(shown, Effect.void);
        });
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({ coordinator, onPrompt }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetchMock),
          ),
        );
        yield* Deferred.await(shown);
        expect(onPrompt).toHaveBeenCalledOnce();
        yield* settle;
        yield* TestClock.adjust('5 seconds');
        yield* settle;

        yield* Fiber.interrupt(fiber);
        inFlight.resolve(
          jsonResponse({
            authorization_code: 'authorization-code',
            code_verifier: 'code-verifier',
          }),
        );

        const exit = yield* Fiber.await(fiber);
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(coordinator.completeDeviceLogin).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'lets the session store finish when interruption lands while it runs',
    () =>
      Effect.gen(function* () {
        const fetchMock = deviceEndpointsFetch({}, async () =>
          jsonResponse({
            authorization_code: 'authorization-code',
            code_verifier: 'code-verifier',
          }),
        );
        const store = createDeferred<{ accessToken: string }>();
        const coordinator = coordinatorStub();
        const storeEntered = yield* Deferred.make<void>();
        vi.mocked(coordinator.completeDeviceLogin).mockImplementation(() => {
          Deferred.doneUnsafe(storeEntered, Effect.void);
          return Effect.promise(() => store.promise) as never;
        });
        const shown = yield* Deferred.make<void>();
        const onPrompt = vi.fn(() => {
          Deferred.doneUnsafe(shown, Effect.void);
        });
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({ coordinator, onPrompt }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetchMock),
          ),
        );
        yield* Deferred.await(shown);
        expect(onPrompt).toHaveBeenCalledOnce();
        yield* settle;
        yield* TestClock.adjust('5 seconds');
        yield* Deferred.await(storeEntered);
        expect(coordinator.completeDeviceLogin).toHaveBeenCalledOnce();

        // The store is uninterruptible: start the interrupt now, so it is
        // pending before resolving the store rather than queued behind this
        // test fiber's next scheduler turn.
        const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber), {
          startImmediately: true,
        });
        expect(fiber.pollUnsafe()).toBeUndefined();
        store.resolve({ accessToken: 'stored' });

        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(fiber);
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
      }),
  );

  it.effect(
    'gives up at the expiry the server reported, not the local fallback',
    () =>
      Effect.gen(function* () {
        let polls = 0;
        const fetchMock = deviceEndpointsFetch({ expires_in: 12 }, async () => {
          polls += 1;
          return jsonResponse({ error: 'authorization_pending' }, 403);
        });
        const shown = yield* Deferred.make<void>();
        const onPrompt = vi.fn(() => {
          Deferred.doneUnsafe(shown, Effect.void);
        });
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({
            coordinator: coordinatorStub(),
            onPrompt,
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetchMock),
          ),
        );
        yield* Deferred.await(shown);
        expect(onPrompt).toHaveBeenCalledOnce();
        yield* settle;

        // Polls at 5s and 10s; the 15-minute fallback would keep polling.
        yield* TestClock.adjust('5 seconds');
        yield* settle;
        yield* TestClock.adjust('5 seconds');
        yield* settle;
        yield* TestClock.adjust('5 seconds');

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: 'DeviceCodeTimedOut',
          message: 'Device-code sign-in timed out. Run sign-in again.',
        });
        expect(polls).toBe(2);
      }),
  );
});
