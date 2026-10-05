/**
 * GitHub REST client with ETag-based conditional requests.
 *
 * Reads through the process `HttpClient` (auth headers, native fetch) and adds
 * the rate-limit / permanent-failure classification the polling layer needs.
 * Callers hold the per-resource ETag and pass it back on subsequent requests;
 * a 304 means "no change since that ETag".
 */

import { Data, Duration, Effect } from 'effect';
import { StatusCodes } from 'http-status-codes';
import { Secrets } from '@platform/secrets';
import { scopedClient } from '@tools/timeouts';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getGitHubToken } from './githubAuth';
import type { Headers, HttpClient } from 'effect/http';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

/** What {@link ghGet} reads from the environment: the token store and the HTTP client. */
export type GitHubServices = Secrets | HttpClient.HttpClient;

export type ConditionalResponse<T> =
  { status: 200; data: T; etag: string | undefined } | { status: 304 };

export class GitHubAuthError extends Data.TaggedError('GitHubAuthError')<{
  readonly message: string;
}> {}

export class GitHubRateLimitError extends Data.TaggedError(
  'GitHubRateLimitError',
)<{ readonly resetAt: number }> {
  override get message(): string {
    return `GitHub rate limit exceeded; resets at ${new Date(this.resetAt * 1000).toISOString()}`;
  }
}

/** An HTTP status that won't recover on retry (404, 410, 422). */
export class GitHubPermanentError extends Data.TaggedError(
  'GitHubPermanentError',
)<{ readonly status: number; readonly message: string }> {}

/**
 * GitHub error responses are `{ message, documentation_url, ... }` JSON
 * objects; fall back to a JSON-stringified form for any other shape.
 */
function extractApiMessage(data: unknown, fallback: string): string {
  if (isNonEmptyString(data)) return data;
  if (data && typeof data === 'object') {
    const rec = data as { message?: unknown };
    if (isNonEmptyString(rec.message)) return rec.message;
    // `data` is a plain GitHub error object (already JSON-parsed), so
    // stringifying it can't realistically throw — no guard needed.
    return JSON.stringify(data);
  }
  return fallback;
}

/** The failure to report for a non-2xx, non-304 response, tagged when it is an HTTP status a caller acts on. */
function classifyFailure(
  status: number,
  responseHeaders: Headers.Headers,
  responseData: unknown,
): Error {
  const message = extractApiMessage(responseData, `HTTP ${status}`);
  if (status === StatusCodes.UNAUTHORIZED || status === StatusCodes.FORBIDDEN) {
    // Primary rate limit: x-ratelimit-remaining hits 0 with an
    // epoch-seconds reset timestamp. Only applies when credentials were
    // otherwise valid.
    const remaining = responseHeaders['x-ratelimit-remaining'];
    const reset = responseHeaders['x-ratelimit-reset'];
    if (remaining === '0' && typeof reset === 'string') {
      return new GitHubRateLimitError({ resetAt: Number(reset) });
    }
    // Secondary / abuse rate limit: 403 with a Retry-After header
    // (seconds from now). Primary-limit headers may still read
    // "non-zero remaining". Without this branch we'd misclassify as an
    // auth error and stop the subscription permanently.
    const retryAfter = responseHeaders['retry-after'];
    if (status === StatusCodes.FORBIDDEN && typeof retryAfter === 'string') {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) {
        return new GitHubRateLimitError({
          resetAt: Math.floor(Date.now() / 1000) + Math.ceil(secs),
        });
      }
    }
    return new GitHubAuthError({
      message: `GitHub returned ${status}: ${message}`,
    });
  }
  // Permanent HTTP failures — retrying won't help; surface immediately so
  // callers can halt rather than burning a slot for 24 h.
  if (
    status === StatusCodes.NOT_FOUND ||
    status === StatusCodes.GONE ||
    status === StatusCodes.UNPROCESSABLE_ENTITY
  ) {
    return new GitHubPermanentError({
      status,
      message: `GitHub returned ${status}: ${message}`,
    });
  }
  return new Error(`GitHub request failed: ${message}`);
}

export const ghGet = Effect.fn('ghGet')(function* <T>(
  path: string,
  etag?: string,
): Effect.fn.Return<ConditionalResponse<T>, Error, GitHubServices> {
  const secrets = yield* Secrets;
  const token = yield* getGitHubToken(secrets);
  const headers: Record<string, string> = {
    'X-GitHub-Api-Version': API_VERSION,
    'user-agent': 'TeXRA-Extension',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (etag) headers['if-none-match'] = etag;

  // One attempt owns headers and body under one deadline; the request scope
  // aborts the request however the attempt ends.
  return yield* Effect.gen(function* () {
    const client = yield* scopedClient;
    const response = yield* client.get(`${API_ORIGIN}${path}`, { headers });
    if (response.status === StatusCodes.NOT_MODIFIED) {
      return { status: 304 } as const;
    }
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.json.pipe(
        Effect.orElseSucceed((): unknown => undefined),
      );
      return yield* Effect.fail(
        classifyFailure(response.status, response.headers, body),
      );
    }
    return {
      status: 200,
      data: (yield* response.json) as T,
      etag: response.headers.etag,
    } as const;
  }).pipe(
    Effect.scoped,
    // A transport failure carries its cause's message; SDK internals stay out.
    Effect.catchTag('HttpClientError', (error) =>
      Effect.fail(
        new Error(
          `GitHub request failed: ${toErrorMessage(error.cause ?? error)}`,
        ),
      ),
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new Error(
            `GitHub request failed (TIMEOUT): request exceeded ${TIMEOUT_MS}ms`,
          ),
        ),
    }),
  );
});
