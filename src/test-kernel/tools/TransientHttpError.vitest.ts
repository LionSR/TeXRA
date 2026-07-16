// Third-party imports
import { HTTPError, TimeoutError } from 'ky';
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { isTransientHttpError } from '@tools/timeouts';

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

  it('treats network failures (no response) as transient', () => {
    // fetch throws TypeError for connection reset, DNS failure, socket hang-up
    expect(isTransientHttpError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientHttpError(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats programmer TypeErrors as permanent (not every TypeError is a network error)', () => {
    // A bug in the wrapped call (reading a property of undefined) must surface,
    // not be silently retried as if it were a transient network failure.
    expect(
      isTransientHttpError(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
      ),
    ).toBe(false);
  });

  it('treats request timeouts, rate limits, and 5xx errors as transient', () => {
    expect(isTransientHttpError(kyErrorWithStatus(408))).toBe(true);
    expect(isTransientHttpError(kyErrorWithStatus(429))).toBe(true);
    expect(isTransientHttpError(kyErrorWithStatus(500))).toBe(true);
    expect(isTransientHttpError(kyErrorWithStatus(503))).toBe(true);
  });

  it('treats 4xx responses as permanent', () => {
    expect(isTransientHttpError(kyErrorWithStatus(400))).toBe(false);
    expect(isTransientHttpError(kyErrorWithStatus(404))).toBe(false);
  });

  it('treats non-http errors as permanent', () => {
    expect(isTransientHttpError(new Error('boom'))).toBe(false);
    expect(isTransientHttpError('nope')).toBe(false);
    expect(isTransientHttpError(undefined)).toBe(false);
  });
});
