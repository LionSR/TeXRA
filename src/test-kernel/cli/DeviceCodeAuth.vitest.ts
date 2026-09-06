import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, vi } from 'vitest';

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

/** Stub `fetch` to serve one queued result per call (Response or throw). */
function queuedFetch(queue: Array<Response | Error>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      calls.push({
        url: String(input),
        body:
          typeof init?.body === 'string' && init.body !== ''
            ? JSON.parse(init.body)
            : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error('queuedFetch ran out of responses');
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }),
  );
  return calls;
}

/** Let the poll's fiber cross its pending `fetch` promise and reach its next wait. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/** Advance the clock through `count` poll intervals, one poll per step. */
const advancePolls = (
  count: number,
  intervalSeconds = AUTHORIZATION.interval,
) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index += 1) {
      yield* TestClock.adjust(`${intervalSeconds} seconds`);
      yield* settle;
    }
  });

/** The failure an exit carries, or undefined when it succeeded. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe('CLI device-code sign-in (texra login --device)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect('cancels a pending poll before its first network request', () =>
    Effect.gen(function* () {
      const calls = queuedFetch([jsonResponse(SESSION_PAYLOAD)]);
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );

      yield* Fiber.interrupt(fiber);

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
      expect(calls).toHaveLength(0);
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
      const calls = queuedFetch([jsonResponse(AUTHORIZATION)]);
      const authorization = yield* requestDeviceAuthorization();
      expect(authorization.device_code).toBe('device-code-secret');
      expect(calls[0].url).toMatch(/\/auth-device\/code$/);
    }),
  );

  it.effect('reports an unavailable device endpoint with a recovery hint', () =>
    Effect.gen(function* () {
      queuedFetch([jsonResponse({ error: 'nope' }, 503)]);
      const exit = yield* Effect.exit(requestDeviceAuthorization());
      expect(failureOf(exit)).toMatchObject({
        _tag: 'DeviceSignInError',
        reason: 'request',
        message: expect.stringMatching(/unavailable.*--no-browser/s),
      });
    }),
  );

  it.effect(
    'polls through pending and slow_down, honoring the growing interval',
    () =>
      Effect.gen(function* () {
        const calls = queuedFetch([
          jsonResponse({ error: 'authorization_pending' }, 400),
          jsonResponse({ error: 'slow_down' }, 400),
          jsonResponse(SESSION_PAYLOAD),
        ]);
        const fiber = yield* Effect.forkChild(
          pollForDeviceSession(AUTHORIZATION),
        );

        // 5s, 5s, then 10s after the slow_down bump.
        yield* advancePolls(2);
        expect(calls).toHaveLength(2);
        yield* advancePolls(1);
        expect(calls).toHaveLength(2);
        yield* advancePolls(1);

        const exchange = yield* Fiber.join(fiber);
        expect(exchange.access_token).toBe('access-token');
        expect(exchange.user.email).toBe('user@example.edu');
        expect(calls).toHaveLength(3);
        expect(
          calls.every((call) => call.url.endsWith('/auth-device/token')),
        ).toBe(true);
        expect(calls[0].body).toEqual({ device_code: 'device-code-secret' });
      }),
  );

  it.effect('surfaces a denial from the browser as a clear error', () =>
    Effect.gen(function* () {
      queuedFetch([jsonResponse({ error: 'access_denied' }, 400)]);
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );
      yield* advancePolls(1);
      expect(failureOf(yield* Fiber.await(fiber))).toMatchObject({
        reason: 'denied',
        message: 'Sign-in was denied in the browser.',
      });
    }),
  );

  it.effect('maps expired_token to a fresh-code suggestion', () =>
    Effect.gen(function* () {
      queuedFetch([jsonResponse({ error: 'expired_token' }, 400)]);
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );
      yield* advancePolls(1);
      expect(failureOf(yield* Fiber.await(fiber))).toMatchObject({
        reason: 'expired',
        message: expect.stringMatching(/expired before it was approved/),
      });
    }),
  );

  it.effect('stops polling when the code expires locally', () =>
    Effect.gen(function* () {
      const calls = queuedFetch([
        jsonResponse({ error: 'authorization_pending' }, 400),
      ]);
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession({ ...AUTHORIZATION, expires_in: 10 }),
      );
      yield* advancePolls(2);
      expect(failureOf(yield* Fiber.await(fiber))).toMatchObject({
        reason: 'expired',
        message: expect.stringMatching(/expired before it was approved/),
      });
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect('tolerates transient poll failures but not persistent ones', () =>
    Effect.gen(function* () {
      queuedFetch([
        new Error('socket hang up'),
        new Error('socket hang up'),
        jsonResponse(SESSION_PAYLOAD),
      ]);
      const tolerant = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );
      yield* advancePolls(3);
      expect((yield* Fiber.join(tolerant)).access_token).toBe('access-token');

      queuedFetch([
        new Error('socket hang up'),
        new Error('socket hang up'),
        new Error('socket hang up'),
      ]);
      const persistent = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );
      yield* advancePolls(3);
      expect(failureOf(yield* Fiber.await(persistent))).toMatchObject({
        reason: 'poll',
        message: 'Device sign-in poll failed: socket hang up',
      });
    }),
  );

  it.effect('treats rate-limited poll responses as transient', () =>
    Effect.gen(function* () {
      queuedFetch([
        jsonResponse({ error: 'rate_limited' }, 429),
        jsonResponse(SESSION_PAYLOAD),
      ]);
      const fiber = yield* Effect.forkChild(
        pollForDeviceSession(AUTHORIZATION),
      );
      yield* advancePolls(2);
      expect((yield* Fiber.join(fiber)).access_token).toBe('access-token');
    }),
  );

  it('describes device login as any-device auth with the code inline', () => {
    const message = formatCliDeviceAuthMessage(AUTHORIZATION);
    expect(message).toContain(CLI_DEVICE_AUTH_URL_PROMPT);
    expect(message).toContain(AUTHORIZATION.verification_uri);
    expect(message).toContain('BCDF-GHJK');
  });
});
