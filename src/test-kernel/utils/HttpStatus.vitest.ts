// Suites for @utils/core/httpStatus (isTransientHttpStatus).

import { describe, expect, it } from 'vitest';

import { isTransientHttpStatus } from '@utils/core/httpStatus';

describe('isTransientHttpStatus', () => {
  it('treats request timeouts, rate limits, and 5xx as transient', () => {
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(503)).toBe(true);
  });

  it('treats other 4xx statuses as permanent', () => {
    expect(isTransientHttpStatus(400)).toBe(false);
    expect(isTransientHttpStatus(404)).toBe(false);
  });
});
