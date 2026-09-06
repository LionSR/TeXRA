import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, vi } from 'vitest';

import {
  CLI_DEVICE_AUTH_URL_PROMPT,
  DeviceAuthorizationSchema,
  formatCliDeviceAuthMessage,
  pollForDeviceSession,
  requestDeviceAuthorization,
} from '@cli/runtime/supabaseAuthDeviceCode';

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

/** Let a settled fetch resume the poll, then move the clock one interval. */
const tick = Effect.gen(function* () {
  yield* Effect.promise(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
  yield* TestClock.adjust(`${AUTHORIZATION.interval} seconds`);
});

/** Forks a poll over a queued fetch on the test clock. */
const pollWithQueue = (
  queue: Array<Response | Error>,
  authorization: Parameters<typeof pollForDeviceSession>[0] = AUTHORIZATION,
) =>
  Effect.gen(function* () {
    const { fetchImpl, calls } = queuedFetch(queue);
    const fiber = yield* Effect.forkChild(
      pollForDeviceSession(authorization, { fetchImpl }),
    );
    return { fiber, calls };
  });

/** Tick until the poll settles (bounded), then its exit. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>, ticks = 12) =>
  Effect.gen(function* () {
    for (let i = 0; i < ticks; i++) {
      yield* tick;
    }
    return yield* Fiber.await(fiber);
  });

describe('CLI device-code sign-in (texra login --device)', () => {
  it.effect('cancels a pending poll before its first network request', () =>
    Effect.gen(function* () {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION, { fetchImpl }),
      );
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    }),
  );

  it('parses a device authorization and defaults a missing interval', () => {
    const parsed = DeviceAuthorizationSchema.parse({
      ...AUTHORIZATION,
      interval: 'bogus',
    });
    expect(parsed.interval).toBe(5);
    expect(parsed.user_code).toBe('BCDF-GHJK');
  });

  it.effect('requests a device authorization from the auth server', () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = queuedFetch([jsonResponse(AUTHORIZATION)]);
      const authorization = yield* requestDeviceAuthorization({ fetchImpl });
      expect(authorization.device_code).toBe('device-code-secret');
      expect(calls[0].url).toMatch(/\/auth-device\/code$/);
    }),
  );

  it.effect('reports an unavailable device endpoint with a recovery hint', () =>
    Effect.gen(function* () {
      const { fetchImpl } = queuedFetch([jsonResponse({ error: 'nope' }, 503)]);
      const error = yield* Effect.flip(
        requestDeviceAuthorization({ fetchImpl }),
      );
      expect(error.message).toMatch(/unavailable.*--no-browser/s);
    }),
  );

  it.effect(
    'polls through pending and slow_down, honoring the growing interval',
    () =>
      Effect.gen(function* () {
        const { fiber, calls } = yield* pollWithQueue([
          jsonResponse({ error: 'authorization_pending' }, 400),
          jsonResponse({ error: 'slow_down' }, 400),
          jsonResponse(SESSION_PAYLOAD),
        ]);

        // 5s, 5s, then 10s after the slow_down bump: the third poll needs two
        // intervals.
        yield* tick;
        expect(calls).toHaveLength(1);
        yield* tick;
        expect(calls).toHaveLength(2);
        yield* tick;
        expect(calls).toHaveLength(2);
        yield* tick;
        expect(calls).toHaveLength(3);

        const exchange = yield* Fiber.join(fiber);
        expect(exchange.access_token).toBe('access-token');
        expect(exchange.user.email).toBe('user@example.edu');
        expect(
          calls.every((call) => call.url.endsWith('/auth-device/token')),
        ).toBe(true);
        expect(calls[0].body).toEqual({ device_code: 'device-code-secret' });
      }),
  );

  it.effect('surfaces a denial from the browser as a clear error', () =>
    Effect.gen(function* () {
      const { fiber } = yield* pollWithQueue([
        jsonResponse({ error: 'access_denied' }, 400),
      ]);
      yield* settle(fiber, 1);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toBe('Sign-in was denied in the browser.');
    }),
  );

  it.effect('maps expired_token to a fresh-code suggestion', () =>
    Effect.gen(function* () {
      const { fiber } = yield* pollWithQueue([
        jsonResponse({ error: 'expired_token' }, 400),
      ]);
      yield* settle(fiber, 1);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toMatch(/expired before it was approved/);
    }),
  );

  it.effect('stops polling when the code expires locally', () =>
    Effect.gen(function* () {
      const { fiber, calls } = yield* pollWithQueue(
        [jsonResponse({ error: 'authorization_pending' }, 400)],
        { ...AUTHORIZATION, expires_in: 10 },
      );
      yield* settle(fiber, 2);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toMatch(/expired before it was approved/);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect('tolerates transient poll failures but not persistent ones', () =>
    Effect.gen(function* () {
      const tolerated = yield* pollWithQueue([
        new Error('socket hang up'),
        new Error('socket hang up'),
        jsonResponse(SESSION_PAYLOAD),
      ]);
      yield* settle(tolerated.fiber, 3);
      const transient = yield* Fiber.join(tolerated.fiber);
      expect(transient.access_token).toBe('access-token');

      const persistent = yield* pollWithQueue([
        new Error('socket hang up'),
        new Error('socket hang up'),
        new Error('socket hang up'),
      ]);
      yield* settle(persistent.fiber, 3);
      const error = yield* Effect.flip(Fiber.join(persistent.fiber));
      expect(error.message).toBe('socket hang up');
    }),
  );

  it.effect('treats rate-limited poll responses as transient', () =>
    Effect.gen(function* () {
      const { fiber } = yield* pollWithQueue([
        jsonResponse({ error: 'rate_limited' }, 429),
        jsonResponse(SESSION_PAYLOAD),
      ]);
      yield* settle(fiber, 2);
      const exchange = yield* Fiber.join(fiber);
      expect(exchange.access_token).toBe('access-token');
    }),
  );

  it('describes device login as any-device auth with the code inline', () => {
    const message = formatCliDeviceAuthMessage(AUTHORIZATION);
    expect(message).toContain(CLI_DEVICE_AUTH_URL_PROMPT);
    expect(message).toContain(AUTHORIZATION.verification_uri);
    expect(message).toContain('BCDF-GHJK');
  });
});
