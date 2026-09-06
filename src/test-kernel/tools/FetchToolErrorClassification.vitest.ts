import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { HTTPError, TimeoutError } from 'ky';
import { describe, expect } from 'vitest';

import { ToolError } from '@shared/schemas';
import { toFetchToolError, withRequestTimeout } from '@tools/timeouts';

const MESSAGES = {
  timeout: 'timed out',
  http: (status: number) => `HTTP ${status}`,
  network: (message: string) => `Network error: ${message}`,
  fallback: (message: string) => `Failed: ${message}`,
} as const;

/** The failure `withRequestTimeout` raises for a request that threw `cause`. */
const failed = (cause: unknown) =>
  Effect.flip(withRequestTimeout(1000, () => Promise.reject(cause)));

/** The failure `withRequestTimeout` raises when the deadline passes first. */
const timedOut = Effect.flip(
  withRequestTimeout(0, () => new Promise<never>(() => {})),
);

/**
 * Regression coverage for the retry/final-label predicate consolidation
 * (`toFetchToolError` reuses `isNetworkError`, the same predicate
 * `isTransientHttpError` uses for the retry decision). A bare `instanceof
 * TypeError` used to label ANY TypeError — including a genuine bug in the
 * fetch/response path — as a network failure, contradicting this module's own
 * guidance; `is-network-error` matches only known fetch/undici network-failure
 * shapes.
 */
describe('toFetchToolError', () => {
  it.effect(
    'labels a genuine fetch network failure (TypeError) as a network error',
    () =>
      Effect.gen(function* () {
        const err = toFetchToolError(
          yield* failed(new TypeError('fetch failed')),
          MESSAGES,
        );
        expect(err).toBeInstanceOf(ToolError);
        expect(err.message).toBe('Network error: fetch failed');
      }),
  );

  it.effect('does not label a non-network TypeError as a network error', () =>
    Effect.gen(function* () {
      // A programmer error in the fetch/response path must surface as the
      // fallback classification, not a misleading "network error".
      const err = toFetchToolError(
        yield* failed(
          new TypeError(
            'Cannot read properties of undefined (reading "status")',
          ),
        ),
        MESSAGES,
      );
      expect(err).toBeInstanceOf(ToolError);
      expect(err.message).toBe(
        'Failed: Cannot read properties of undefined (reading "status")',
      );
    }),
  );

  it.live('keeps timeout and HTTP classifications distinct', () =>
    Effect.gen(function* () {
      const request = new Request('https://example.com');
      expect(
        toFetchToolError(yield* failed(new TimeoutError(request)), MESSAGES)
          .message,
      ).toBe('timed out');
      expect(toFetchToolError(yield* timedOut, MESSAGES).message).toBe(
        'timed out',
      );

      const response = new Response('', { status: 503 });
      // ky requires NormalizedOptions; tests only need status/request metadata.
      const httpError = new HTTPError(response, request, {} as never);
      expect(toFetchToolError(yield* failed(httpError), MESSAGES).message).toBe(
        'HTTP 503',
      );
    }),
  );
});
