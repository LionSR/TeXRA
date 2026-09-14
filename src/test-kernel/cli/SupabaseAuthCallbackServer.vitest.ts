// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  type SupabaseSession,
  type SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import {
  startLoopbackCallbackServer,
  type LoopbackCallbackServer,
} from '@cli/runtime/supabaseAuthCallbackServer';
import { effectRuntime } from '@platform/processRuntime';

function stubCoordinator(
  overrides: {
    createSessionFromCallback?: ReturnType<typeof vi.fn>;
    storeSession?: ReturnType<typeof vi.fn>;
  } = {},
): SupabaseSessionCoordinator {
  return {
    createSessionFromCallback: vi.fn(),
    storeSession: vi.fn(() => Effect.void),
    ...overrides,
  } as unknown as SupabaseSessionCoordinator;
}

/** The composition the sign-in edge runs: the wait, with cancellation
 *  refusing further callbacks on interruption. */
const waitForSession = (
  server: LoopbackCallbackServer,
): Effect.Effect<SupabaseSession, Error> =>
  server.waitForSession.pipe(Effect.onInterrupt(() => server.cancel));

/** Own the loopback server for the whole Effect: acquired on the process
 *  runtime, the way the sign-in edge starts it and where its request
 *  handlers fork, and closed even when an assertion fails. */
const withServer = <A, E>(
  coordinator: SupabaseSessionCoordinator,
  use: (server: LoopbackCallbackServer) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      effectRuntime().runPromise(
        startLoopbackCallbackServer(effectRuntime(), coordinator),
      ),
    ),
    use,
    (server) => Effect.promise(() => effectRuntime().runPromise(server.close)),
  );

async function fetchCallbackNonce(
  server: LoopbackCallbackServer,
): Promise<string> {
  const callbackPage = await fetch(`${server.redirectTo}?code=oauth-code`);
  const nonce = (await callbackPage.text()).match(/nonce: "([^"]+)"/)?.[1];
  expect(nonce).toBeDefined();
  return nonce as string;
}

function postCallbackCompletion(
  server: LoopbackCallbackServer,
  nonce: string,
): Promise<Response> {
  return fetch(`${server.redirectTo}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '?code=oauth-code', nonce }),
  });
}

// it.live throughout: a real loopback socket and real fetches, and every
// request handler runs on the process runtime's live clock (the module
// forks each request there). No TestClock: the only Effect.sleep in the
// module is the 10-minute login-attempt timeout that `close` retires, and
// no test exercises it.
describe('CLI Supabase authentication callback server', () => {
  it.live('stops waiting when interactive sign-in is cancelled', () => {
    const coordinator = stubCoordinator();
    return withServer(coordinator, (server) =>
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(waitForSession(server), {
          startImmediately: true,
        });
        yield* Fiber.interrupt(waiting);
        expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);

        const response = yield* Effect.promise(() =>
          fetch(`${server.redirectTo}/complete`, { method: 'POST' }),
        );
        expect(response.status).toBe(400);
        expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
        expect(coordinator.storeSession).not.toHaveBeenCalled();
      }),
    );
  });

  it.live('does not store a callback that finishes after cancellation', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<unknown>();
      const createSessionFromCallback = vi.fn(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
        ),
      );
      const storeSession = vi.fn();
      const coordinator = stubCoordinator({
        createSessionFromCallback,
        storeSession,
      });
      yield* withServer(coordinator, (server) =>
        Effect.gen(function* () {
          const nonce = yield* Effect.promise(() => fetchCallbackNonce(server));
          const waiting = yield* Effect.forkChild(waitForSession(server), {
            startImmediately: true,
          });
          const callbackResponse = postCallbackCompletion(server, nonce);
          yield* Deferred.await(entered);
          expect(createSessionFromCallback).toHaveBeenCalled();

          // Interrupting first is what pins the ordering: Fiber.interrupt
          // returns only after the wait fiber has exited and its onInterrupt
          // ran `cancel` (refusing further callbacks), so the exchange parked
          // in the stub resumes into the refusal.
          yield* Fiber.interrupt(waiting);
          expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
          yield* Deferred.succeed(finish, {
            success: true,
            session: { account: { label: 'person@example.edu' } },
          });

          expect((yield* Effect.promise(() => callbackResponse)).status).toBe(
            400,
          );
          expect(storeSession).not.toHaveBeenCalled();
        }),
      );
    }),
  );

  it.live(
    'finishes a callback whose storage commit began before cancellation',
    () =>
      Effect.gen(function* () {
        const commitEntered = yield* Deferred.make<void>();
        const finishStorage = yield* Deferred.make<void>();
        const session = { account: { label: 'person@example.edu' } };
        const storeSession = vi.fn(() =>
          Deferred.succeed(commitEntered, undefined).pipe(
            Effect.andThen(Deferred.await(finishStorage)),
          ),
        );
        const coordinator = stubCoordinator({
          createSessionFromCallback: vi
            .fn()
            .mockReturnValue(Effect.succeed({ success: true, session })),
          storeSession,
        });
        yield* withServer(coordinator, (server) =>
          Effect.gen(function* () {
            const nonce = yield* Effect.promise(() =>
              fetchCallbackNonce(server),
            );
            // The bare wait, with no `cancel` on interruption: the sticky v4
            // interruption belongs to the `waiting` fiber, and the test fiber,
            // never interrupted, is the fresh await that observes the session
            // the commit-in-flight grace still delivers.
            const waiting = yield* Effect.forkChild(server.waitForSession, {
              startImmediately: true,
            });
            const callbackResponse = postCallbackCompletion(server, nonce);
            yield* Deferred.await(commitEntered);
            expect(storeSession).toHaveBeenCalled();

            yield* Fiber.interrupt(waiting);
            const exit = yield* Fiber.await(waiting);
            yield* Deferred.succeed(finishStorage, undefined);

            expect(Exit.isFailure(exit)).toBe(true);
            expect(server.commitStarted).toBe(true);
            expect(yield* server.waitForSession).toBe(session);
            expect((yield* Effect.promise(() => callbackResponse)).status).toBe(
              200,
            );
          }),
        );
      }),
  );
});
