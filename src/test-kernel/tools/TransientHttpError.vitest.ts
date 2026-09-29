// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/unstable/http';
import { describe, expect } from 'vitest';

// Local imports - tools
import { retryTransientFetch } from '@tools/timeouts';

const request = HttpClientRequest.get('https://example.com');

function statusError(status: number): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(
        request,
        new Response(null, { status }),
      ),
    }),
  });
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
  error: Error,
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
  it.effect('treats the request deadline as transient', () =>
    expectTransience(new Cause.TimeoutError(), true),
  );

  it.effect('treats a transport failure (no response) as transient', () =>
    expectTransience(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: new TypeError('fetch failed'),
        }),
      }),
      true,
    ),
  );

  it.effect.each([408, 429, 500, 503])(
    'treats request timeouts, rate limits, and 5xx errors as transient: HTTP %i',
    (status) => expectTransience(statusError(status), true),
  );

  it.effect.each([400, 404])(
    'treats 4xx responses as permanent: HTTP %i',
    (status) => expectTransience(statusError(status), false),
  );

  it.effect.each([
    new Error('boom'),
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request,
        response: HttpClientResponse.fromWeb(request, new Response('x')),
      }),
    }),
  ])('treats other failures as permanent: %s', (error) =>
    expectTransience(error, false),
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
            retryTransientFetch(Effect.fail(statusError(503)), {
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
        expect(HttpClientError.isHttpClientError(error)).toBe(true);
        expect(retriesLeft).toEqual([3, 2, 1, 0]);
      }),
  );
});
