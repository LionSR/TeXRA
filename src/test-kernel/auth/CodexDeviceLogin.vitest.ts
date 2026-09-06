import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, vi } from 'vitest';

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
 * every token poll goes to `onPoll`.
 */
function stubDeviceEndpoints(
  userCode: Record<string, unknown>,
  onPoll: (init: RequestInit | undefined) => Promise<Response>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === CODEX_DEVICE_USERCODE_URL) {
        return jsonResponse({
          device_auth_id: 'device-auth-id',
          user_code: 'ABCD-EFGH',
          interval: 5,
          ...userCode,
        });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) return onPoll(init);
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function coordinatorStub(): CodexSessionCoordinator {
  return { completeDeviceLogin: vi.fn() } as unknown as CodexSessionCoordinator;
}

/** Let the flow's fiber cross its pending `fetch` promises and reach its next wait. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/** The flow has shown the prompt, so it is at (or past) its first wait. */
const prompted = (onPrompt: ReturnType<typeof vi.fn>) =>
  Effect.promise(() =>
    vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce()),
  ).pipe(Effect.andThen(settle));

describe('Codex device login', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    'does not exchange a token when interruption lands during a poll',
    () =>
      Effect.gen(function* () {
        const inFlight = createDeferred<Response>();
        stubDeviceEndpoints({}, () => inFlight.promise);
        const coordinator = coordinatorStub();
        const onPrompt = vi.fn();
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({ coordinator, onPrompt }),
        );
        yield* prompted(onPrompt);
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
        stubDeviceEndpoints({}, async () =>
          jsonResponse({
            authorization_code: 'authorization-code',
            code_verifier: 'code-verifier',
          }),
        );
        const store = createDeferred<{ accessToken: string }>();
        const coordinator = coordinatorStub();
        vi.mocked(coordinator.completeDeviceLogin).mockReturnValue(
          store.promise as never,
        );
        const onPrompt = vi.fn();
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({ coordinator, onPrompt }),
        );
        yield* prompted(onPrompt);
        yield* TestClock.adjust('5 seconds');
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(coordinator.completeDeviceLogin).toHaveBeenCalledOnce(),
          ),
        );

        // The store is uninterruptible: the interrupt waits for it to settle.
        const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* settle;
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
        stubDeviceEndpoints({ expires_in: 12 }, async () => {
          polls += 1;
          return jsonResponse({ error: 'authorization_pending' }, 403);
        });
        const onPrompt = vi.fn();
        const fiber = yield* Effect.forkChild(
          loginWithDeviceCode({ coordinator: coordinatorStub(), onPrompt }),
        );
        yield* prompted(onPrompt);

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
