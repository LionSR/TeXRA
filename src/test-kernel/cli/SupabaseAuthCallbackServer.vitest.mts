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
    await server.close();
  });
});
