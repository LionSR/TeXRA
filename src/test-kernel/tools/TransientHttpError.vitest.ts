// Third-party imports
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { isTransientHttpError } from '@tools/timeouts';

function axiosErrorWithStatus(status: number): AxiosError {
  const error = new AxiosError('http error', 'ERR_BAD_RESPONSE');
  error.response = {
    status,
    statusText: '',
    data: undefined,
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

describe('isTransientHttpError', () => {
  it('treats request timeouts as transient', () => {
    expect(
      isTransientHttpError(new AxiosError('timeout', 'ECONNABORTED')),
    ).toBe(true);
    expect(isTransientHttpError(new AxiosError('timeout', 'ETIMEDOUT'))).toBe(
      true,
    );
  });

  it('treats network failures with no response as transient', () => {
    // No `.response` set — the request never completed.
    expect(isTransientHttpError(new AxiosError('reset', 'ECONNRESET'))).toBe(
      true,
    );
  });

  it('treats 5xx server errors as transient', () => {
    expect(isTransientHttpError(axiosErrorWithStatus(500))).toBe(true);
    expect(isTransientHttpError(axiosErrorWithStatus(503))).toBe(true);
  });

  it('treats 4xx responses as permanent', () => {
    expect(isTransientHttpError(axiosErrorWithStatus(400))).toBe(false);
    expect(isTransientHttpError(axiosErrorWithStatus(404))).toBe(false);
    expect(isTransientHttpError(axiosErrorWithStatus(429))).toBe(false);
  });

  it('treats non-axios errors as permanent', () => {
    expect(isTransientHttpError(new Error('boom'))).toBe(false);
    expect(isTransientHttpError('nope')).toBe(false);
    expect(isTransientHttpError(undefined)).toBe(false);
  });
});
