import { describe, expect, it, vi } from 'vitest';
import { Effect, Exit } from 'effect';

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

function startServer(
  coordinator: SupabaseSessionCoordinator,
): Promise<LoopbackCallbackServer> {
  return effectRuntime().runPromise(startLoopbackCallbackServer(coordinator));
}

/** The composition the sign-in edge runs: the wait, with cancellation
 *  refusing further callbacks on interruption. */
function waitForSession(
  server: LoopbackCallbackServer,
  signal?: AbortSignal,
): Promise<SupabaseSession> {
  return effectRuntime().runPromise(
    server.waitForSession.pipe(Effect.onInterrupt(() => server.cancel)),
    { signal },
  );
}

function closeServer(server: LoopbackCallbackServer): Promise<void> {
  return effectRuntime().runPromise(server.close);
}

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

describe('CLI Supabase authentication callback server', () => {
  it('stops waiting when interactive sign-in is cancelled', async () => {
    const coordinator = stubCoordinator();
    const server = await startServer(coordinator);
    const controller = new AbortController();
    const completion = waitForSession(server, controller.signal);
    const rejection = expect(completion).rejects.toThrow(/interrupted/);

    controller.abort();

    await rejection;
    const response = await fetch(`${server.redirectTo}/complete`, {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    await closeServer(server);
  });

  it('does not store a callback that finishes after cancellation', async () => {
    let finishCallback!: (result: unknown) => void;
    const createSessionFromCallback = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            finishCallback = resolve;
          }),
      ),
    );
    const storeSession = vi.fn();
    const coordinator = stubCoordinator({
      createSessionFromCallback,
      storeSession,
    });
    const server = await startServer(coordinator);
    const nonce = await fetchCallbackNonce(server);
    const controller = new AbortController();
    const completion = waitForSession(server, controller.signal);
    const rejection = expect(completion).rejects.toThrow(/interrupted/);
    const callbackResponse = postCallbackCompletion(server, nonce);
    await vi.waitFor(() =>
      expect(createSessionFromCallback).toHaveBeenCalled(),
    );

    controller.abort();
    // Awaiting the rejection first is what pins the ordering: the cancel
    // lands (refusing further callbacks) before the in-flight exchange
    // settles, so its resumed continuation meets the refusal.
    await rejection;
    finishCallback({
      success: true,
      session: { account: { label: 'person@example.edu' } },
    });

    expect((await callbackResponse).status).toBe(400);
    expect(storeSession).not.toHaveBeenCalled();
    await closeServer(server);
  });

  it('finishes a callback whose storage commit began before cancellation', async () => {
    let finishStorage!: () => void;
    const session = { account: { label: 'person@example.edu' } };
    const storeSession = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            finishStorage = resolve;
          }),
      ),
    );
    const coordinator = stubCoordinator({
      createSessionFromCallback: vi
        .fn()
        .mockReturnValue(Effect.succeed({ success: true, session })),
      storeSession,
    });
    const server = await startServer(coordinator);
    const nonce = await fetchCallbackNonce(server);
    const controller = new AbortController();
    // The Promise edge's shape: settle the wait as an Exit so the
    // commit-in-flight grace can re-await the session on a fresh fiber (v4
    // fiber interruption is sticky and cannot be recovered in-runtime).
    const interrupted = effectRuntime().runPromiseExit(server.waitForSession, {
      signal: controller.signal,
    });
    const callbackResponse = postCallbackCompletion(server, nonce);
    await vi.waitFor(() => expect(storeSession).toHaveBeenCalled());

    controller.abort();
    finishStorage();

    const exit = await interrupted;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(server.commitStarted).toBe(true);
    await expect(
      effectRuntime().runPromise(server.waitForSession),
    ).resolves.toBe(session);
    expect((await callbackResponse).status).toBe(200);
    await closeServer(server);
  });
});
