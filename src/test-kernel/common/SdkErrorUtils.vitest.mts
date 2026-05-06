// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - common errors
import {
  formatProviderHttpError,
  isUserAbort,
} from '@common/errors/sdkErrorUtils';

class APIError extends Error {}

class UnknownSdkApiError extends APIError {}
class APIUserAbortError extends APIError {}

describe('formatProviderHttpError', () => {
  it('matches generic SDK API errors through the prototype chain', () => {
    const formatted = formatProviderHttpError(
      new UnknownSdkApiError('new provider error shape'),
    );

    expect(formatted.message).toBe('new provider error shape');
    expect(formatted.retryable).toBe(false);
  });

  it('matches SDK abort errors through the prototype chain', () => {
    expect(isUserAbort(new APIUserAbortError('aborted'))).toBe(true);
  });
});
