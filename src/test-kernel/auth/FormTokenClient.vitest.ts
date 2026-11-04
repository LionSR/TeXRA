// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import { postOAuthForm } from '../../../packages/llm/src/oauth/oauthRequest.js';

describe('postOAuthForm', () => {
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
          postOAuthForm(
            'https://example.test/token',
            new URLSearchParams(),
          ).pipe(
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
          'Network error contacting https://example.test/token: The operation was aborted due to timeout',
      });
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    }),
  );
});
