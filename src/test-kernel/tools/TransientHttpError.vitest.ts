// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { HTTPError, TimeoutError } from 'ky';
import { describe, expect } from 'vitest';

// Local imports - tools
import { retryTransientFetch } from '@tools/timeouts';
import { isTransientHttpStatus } from '@utils/core/httpStatus';

function kyErrorWithStatus(status: number): HTTPError {
  return new HTTPError(
    new Response(null, { status }),
    new Request('https://example.com'),
    {} as never,
  );
}

/**
 * Assert whether `retryTransientFetch` treats `error` as transient, by the
 * only consequence that matters to a caller: a transient failure runs the
 * request a second time, a permanent one ends the program on its first
 * attempt. Counting executions inside the request effect covers the retry
 * wiring as well, which an `onFailedAttempt` flag would not: that hook runs
 * from `Effect.tapError` gated on the same classifier, so it fires on the
 * initial failure whether or not another attempt follows.
 */
function expectTransience(
  error: unknown,
  transient: boolean,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let attempts = 0;
    const fiber = yield* Effect.forkChild(
      Effect.flip(
        retryTransientFetch(
          Effect.sync(() => {
            attempts += 1;
          }).pipe(Effect.andThen(Effect.fail(error))),
          { retries: 1, minTimeout: 1, timeoutMs: 1000 },
        ),
      ),
    );
    yield* TestClock.adjust('40 millis');
    yield* Fiber.join(fiber);
    expect(attempts).toBe(transient ? 2 : 1);
  });
}

describe('retryTransientFetch transience classification', () => {
  it.effect('treats ky TimeoutError as transient', () =>
    expectTransience(
      new TimeoutError(new Request('https://example.com')),
      true,
    ),
  );

  it.effect('treats AbortSignal.timeout() errors as transient', () => {
    const err = Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
    return expectTransience(err, true);
  });

  it.effect(
    'treats AbortError with TimeoutError cause as transient (undici wrapping)',
    () => {
      const cause = Object.assign(new Error('signal timed out'), {
        name: 'TimeoutError',
      });
      const err = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        cause,
      });
      return expectTransience(err, true);
    },
  );

  it.effect.each(['Failed to fetch', 'fetch failed'])(
    'treats network failures (no response) as transient: %s',
    // fetch throws TypeError for connection reset, DNS failure, socket hang-up
    (message) => expectTransience(new TypeError(message), true),
  );

  it.effect(
    'treats programmer TypeErrors as permanent (not every TypeError is a network error)',
    () =>
      // A bug in the wrapped call (reading a property of undefined) must
      // surface, not be silently retried as if it were a transient network
      // failure.
      expectTransience(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
        false,
      ),
  );

  it.effect.each([408, 429, 500, 503])(
    'treats request timeouts, rate limits, and 5xx errors as transient: HTTP %i',
    (status) => expectTransience(kyErrorWithStatus(status), true),
  );

  it.effect.each([400, 404])(
    'treats 4xx responses as permanent: HTTP %i',
    (status) => expectTransience(kyErrorWithStatus(status), false),
  );

  it.effect.each([new Error('boom'), 'nope', undefined])(
    'treats non-http errors as permanent: %s',
    (value) => expectTransience(value, false),
  );
});

describe('retryTransientFetch / isTransientHttpStatus parity', () => {
  it.effect('agrees on ky HTTPError status codes', () =>
    Effect.gen(function* () {
      for (const status of [400, 404, 408, 429, 500, 503]) {
        yield* expectTransience(
          kyErrorWithStatus(status),
          isTransientHttpStatus(status),
        );
      }
    }),
  );
});

describe('retryTransientFetch', () => {
  it.effect(
    'reports retries left per transient attempt, the exhausted one included',
    () =>
      Effect.gen(function* () {
        const retriesLeft: number[] = [];
        const fiber = yield* Effect.forkChild(
          Effect.flip(
            retryTransientFetch(Effect.fail(kyErrorWithStatus(503)), {
              retries: 3,
              minTimeout: 1,
              timeoutMs: 1000,
              onFailedAttempt: (_error, left) =>
                Effect.sync(() => {
                  retriesLeft.push(left);
                }),
            }),
          ),
        );
        // The three backoff intervals together take less than 14 ms.
        yield* TestClock.adjust('40 millis');
        const error = yield* Fiber.join(fiber);
        expect(error._tag).toBe('RequestFailed');
        expect(error.cause).toBeInstanceOf(HTTPError);
        expect(retriesLeft).toEqual([3, 2, 1, 0]);
      }),
  );
});
