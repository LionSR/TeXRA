// Third-party imports
import { HTTPError, TimeoutError } from 'ky';
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { isTransientHttpError } from '@tools/timeouts';
import { isTransientHttpStatus } from '@utils/core/httpStatus';

function kyErrorWithStatus(status: number): HTTPError {
  return new HTTPError(
    new Response(null, { status }),
    new Request('https://example.com'),
    {} as never,
  );
}

describe('isTransientHttpError', () => {
  it('treats ky TimeoutError as transient', () => {
    expect(
      isTransientHttpError(
        new TimeoutError(new Request('https://example.com')),
      ),
    ).toBe(true);
  });

  it('treats AbortSignal.timeout() errors as transient', () => {
    const err = Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
    expect(isTransientHttpError(err)).toBe(true);
  });

  it('treats AbortError with TimeoutError cause as transient (undici wrapping)', () => {
    const cause = Object.assign(new Error('signal timed out'), {
      name: 'TimeoutError',
    });
    const err = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      cause,
    });
    expect(isTransientHttpError(err)).toBe(true);
  });

  it.each(['Failed to fetch', 'fetch failed'])(
    'treats network failures (no response) as transient: %s',
    (message) => {
      // fetch throws TypeError for connection reset, DNS failure, socket hang-up
      expect(isTransientHttpError(new TypeError(message))).toBe(true);
    },
  );

  it('treats programmer TypeErrors as permanent (not every TypeError is a network error)', () => {
    // A bug in the wrapped call (reading a property of undefined) must surface,
    // not be silently retried as if it were a transient network failure.
    expect(
      isTransientHttpError(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
      ),
    ).toBe(false);
  });

  it.each([408, 429, 500, 503])(
    'treats request timeouts, rate limits, and 5xx errors as transient: HTTP %i',
    (status) => {
      expect(isTransientHttpError(kyErrorWithStatus(status))).toBe(true);
    },
  );

  it.each([400, 404])(
    'treats 4xx responses as permanent: HTTP %i',
    (status) => {
      expect(isTransientHttpError(kyErrorWithStatus(status))).toBe(false);
    },
  );

  it.each([new Error('boom'), 'nope', undefined])(
    'treats non-http errors as permanent: %s',
    (value) => {
      expect(isTransientHttpError(value)).toBe(false);
    },
  );
});

describe('isTransientHttpError / isTransientHttpStatus parity', () => {
  it('agrees on ky HTTPError status codes', () => {
    for (const status of [400, 404, 408, 429, 500, 503]) {
      expect(isTransientHttpStatus(status)).toBe(
        isTransientHttpError(kyErrorWithStatus(status)),
      );
    }
  });
});
