import { describe, expect, it, vi } from 'vitest';

import { type SupabaseSessionCoordinator } from '@auth/SupabaseSession';
import { startLoopbackCallbackServer } from '@cli/runtime/supabaseAuthCallbackServer';

describe('CLI Supabase authentication callback server', () => {
  it('stops waiting when interactive sign-in is cancelled', async () => {
    const coordinator = {
      createSessionFromCallback: vi.fn(),
      storeSession: vi.fn(),
    } as unknown as SupabaseSessionCoordinator;
    const server = await startLoopbackCallbackServer(coordinator);
    const controller = new AbortController();
    const completion = server.waitForSession(controller.signal);
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });

    controller.abort();

    await rejection;
    const response = await fetch(`${server.redirectTo}/complete`, {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    await server.close();
  });

  it('does not store a callback that finishes after cancellation', async () => {
    let finishCallback!: (result: unknown) => void;
    const createSessionFromCallback = vi.fn(
      () =>
        new Promise((resolve) => {
          finishCallback = resolve;
        }),
    );
    const storeSession = vi.fn();
    const coordinator = {
      createSessionFromCallback,
      storeSession,
    } as unknown as SupabaseSessionCoordinator;
    const server = await startLoopbackCallbackServer(coordinator);
    const callbackPage = await fetch(`${server.redirectTo}?code=oauth-code`);
    const nonce = (await callbackPage.text()).match(/nonce: "([^"]+)"/)?.[1];
    expect(nonce).toBeDefined();
    const controller = new AbortController();
    const completion = server.waitForSession(controller.signal);
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });
    const callbackResponse = fetch(`${server.redirectTo}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '?code=oauth-code', nonce }),
    });
    await vi.waitFor(() =>
      expect(createSessionFromCallback).toHaveBeenCalled(),
    );

    controller.abort();
    finishCallback({
      success: true,
      session: { account: { label: 'person@example.edu' } },
    });

    await rejection;
    expect((await callbackResponse).status).toBe(400);
    expect(storeSession).not.toHaveBeenCalled();
    await server.close();
  });
});
