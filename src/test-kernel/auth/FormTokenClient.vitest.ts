// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import { postOAuth } from '../../../packages/llm/src/oauth/oauthRequest.js';

describe('postOAuth', () => {
  it.effect('times out a response whose body stalls after the headers', () =>
    Effect.gen(function* () {
      // The stream never closes, so only a deadline over the body read can end
      // the request; the fetch signal must be aborted so the stream is released.
      const fetched = Deferred.makeUnsafe<void>();
      const fetchMock = vi.fn<typeof fetch>(async () => {
        Deferred.doneUnsafe(fetched, Effect.void);
        return new Response(new ReadableStream(), { status: 200 });
      });

      const request = yield* Effect.forkChild(
        Effect.flip(
          postOAuth({
            url: 'https://example.test/token',
            headers: {},
            body: '',
            networkErrorMessage: 'Network error contacting token',
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetchMock),
          ),
        ),
      );
      yield* Deferred.await(fetched);
      yield* TestClock.adjust('30 seconds');
      const error = yield* Fiber.join(request);
      expect(error).toMatchObject({
        _tag: 'OAuthNetworkError',
        message:
          'Network error contacting token: The operation was aborted due to timeout',
      });
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    }),
  );
});
