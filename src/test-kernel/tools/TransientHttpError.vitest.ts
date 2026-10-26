// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http';
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

describe('retryTransientFetch transience classification', () => {
  // A transient failure runs the request a second time; a permanent one ends
  // the program on its first attempt.
  it.effect.each([
    [429, 2],
    [503, 2],
    [404, 1],
  ])('HTTP %i runs the request %i time(s)', ([status, expected]) =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          retryTransientFetch(
            Effect.sync(() => {
              attempts += 1;
            }).pipe(Effect.andThen(Effect.fail(statusError(status)))),
            { retries: 1, minTimeout: 1, timeoutMs: 1000 },
          ),
        ),
      );
      yield* TestClock.adjust('40 millis');
      yield* Fiber.join(fiber);
      expect(attempts).toBe(expected);
    }),
  );
});
