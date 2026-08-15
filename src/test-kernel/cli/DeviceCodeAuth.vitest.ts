import { describe, expect, it, vi } from 'vitest';

import {
  CLI_DEVICE_AUTH_URL_PROMPT,
  DeviceAuthorizationSchema,
  formatCliDeviceAuthMessage,
  pollForDeviceSession,
  requestDeviceAuthorization,
} from '@cli/runtime/supabaseAuthDeviceCode';

import { createFakeClock } from '@test/support/asyncTestUtils';
import { jsonResponse } from '@test/support/fetchTestUtils';

const SESSION_PAYLOAD = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: 1_750_000_000,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'user@example.edu' },
};

const AUTHORIZATION = {
  device_code: 'device-code-secret',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://remote.texra.ai/functions/v1/auth-device/verify',
  expires_in: 900,
  interval: 5,
};

type FetchCall = { url: string; body: unknown };

/** Fetch fake that serves one queued result per call (Response or throw). */
function queuedFetch(queue: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error('queuedFetch ran out of responses');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Starts a poll over a queued fetch driven by a fresh deterministic clock. */
function pollWithQueue(
  queue: Array<Response | Error>,
  authorization: Parameters<typeof pollForDeviceSession>[0] = AUTHORIZATION,
): {
  completion: ReturnType<typeof pollForDeviceSession>;
  clock: ReturnType<typeof createFakeClock>;
  calls: FetchCall[];
} {
  const clock = createFakeClock();
  const { fetchImpl, calls } = queuedFetch(queue);
  return {
    completion: pollForDeviceSession(authorization, {
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    }),
    clock,
    calls,
  };
}

describe('CLI device-code sign-in (texra login --device)', () => {
  it('cancels a pending poll before its first network request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const completion = pollForDeviceSession(AUTHORIZATION, {
      fetchImpl,
      signal: controller.signal,
    });

    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses a device authorization and defaults a missing interval', () => {
    const parsed = DeviceAuthorizationSchema.parse({
      ...AUTHORIZATION,
      interval: 'bogus',
    });
    expect(parsed.interval).toBe(5);
    expect(parsed.user_code).toBe('BCDF-GHJK');
  });

  it('requests a device authorization from the auth server', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse(AUTHORIZATION)]);
    const authorization = await requestDeviceAuthorization({ fetchImpl });
    expect(authorization.device_code).toBe('device-code-secret');
    expect(calls[0].url).toMatch(/\/auth-device\/code$/);
  });

  it('reports an unavailable device endpoint with a recovery hint', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({ error: 'nope' }, 503)]);
    await expect(requestDeviceAuthorization({ fetchImpl })).rejects.toThrow(
      /unavailable.*--no-browser/s,
    );
  });

  it('polls through pending and slow_down, honoring the growing interval', async () => {
    const { completion, clock, calls } = pollWithQueue([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse(SESSION_PAYLOAD),
    ]);

    const exchange = await completion;

    expect(exchange.access_token).toBe('access-token');
    expect(exchange.user.email).toBe('user@example.edu');
    // 5s, 5s, then 10s after the slow_down bump.
    expect(clock.sleeps).toEqual([5000, 5000, 10000]);
    expect(calls.every((call) => call.url.endsWith('/auth-device/token'))).toBe(
      true,
    );
    expect(calls[0].body).toEqual({ device_code: 'device-code-secret' });
  });

  it('surfaces a denial from the browser as a clear error', async () => {
    await expect(
      pollWithQueue([jsonResponse({ error: 'access_denied' }, 400)]).completion,
    ).rejects.toThrow('Sign-in was denied in the browser.');
  });

  it('maps expired_token to a fresh-code suggestion', async () => {
    await expect(
      pollWithQueue([jsonResponse({ error: 'expired_token' }, 400)]).completion,
    ).rejects.toThrow(/expired before it was approved/);
  });

  it('stops polling when the code expires locally', async () => {
    const { completion, calls } = pollWithQueue(
      [jsonResponse({ error: 'authorization_pending' }, 400)],
      { ...AUTHORIZATION, expires_in: 10 },
    );
    await expect(completion).rejects.toThrow(/expired before it was approved/);
    expect(calls).toHaveLength(1);
  });

  it('tolerates transient poll failures but not persistent ones', async () => {
    const transient = await pollWithQueue([
      new Error('socket hang up'),
      new Error('socket hang up'),
      jsonResponse(SESSION_PAYLOAD),
    ]).completion;
    expect(transient.access_token).toBe('access-token');

    await expect(
      pollWithQueue([
        new Error('socket hang up'),
        new Error('socket hang up'),
        new Error('socket hang up'),
      ]).completion,
    ).rejects.toThrow('socket hang up');
  });

  it('treats rate-limited poll responses as transient', async () => {
    const exchange = await pollWithQueue([
      jsonResponse({ error: 'rate_limited' }, 429),
      jsonResponse(SESSION_PAYLOAD),
    ]).completion;
    expect(exchange.access_token).toBe('access-token');
  });

  it('describes device login as any-device auth with the code inline', () => {
    const message = formatCliDeviceAuthMessage(AUTHORIZATION);
    expect(message).toContain(CLI_DEVICE_AUTH_URL_PROMPT);
    expect(message).toContain(AUTHORIZATION.verification_uri);
    expect(message).toContain('BCDF-GHJK');
  });
});
