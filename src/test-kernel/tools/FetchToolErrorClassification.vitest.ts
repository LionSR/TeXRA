import { describe, expect, it } from 'vitest';
import { HTTPError, TimeoutError } from 'ky';

import { ToolError } from '@shared/schemas/toolResult';
import { toFetchToolError } from '@tools/timeouts';

const MESSAGES = {
  timeout: 'timed out',
  http: (status: number) => `HTTP ${status}`,
  network: (message: string) => `Network error: ${message}`,
  fallback: (message: string) => `Failed: ${message}`,
} as const;

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
  it('labels a genuine fetch network failure (TypeError) as a network error', () => {
    const err = toFetchToolError(
      new TypeError('fetch failed'),
      MESSAGES,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe('Network error: fetch failed');
  });

  it('does not label a non-network TypeError as a network error', () => {
    // A programmer error in the fetch/response path must surface as the
    // fallback classification, not a misleading "network error".
    const err = toFetchToolError(
      new TypeError('Cannot read properties of undefined (reading "status")'),
      MESSAGES,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe(
      'Failed: Cannot read properties of undefined (reading "status")',
    );
  });

  it('keeps timeout and HTTP classifications distinct', () => {
    expect(toFetchToolError(new TimeoutError(), MESSAGES).message).toBe(
      'timed out',
    );

    const response = new Response('', { status: 503 });
    const httpError = new HTTPError(response, 'GET', 'https://example.com');
    expect(toFetchToolError(httpError, MESSAGES).message).toBe('HTTP 503');
  });
});
