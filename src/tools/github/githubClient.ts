/**
 * GitHub REST client with ETag-based conditional requests.
 *
 * Uses `@octokit/request` for the HTTP layer (auth headers, status handling,
 * native fetch) and adds the rate-limit / permanent-failure classification
 * the polling layer needs. Callers hold the per-resource ETag and pass it
 * back on subsequent requests; a 304 means "no change since that ETag".
 */

import { request as octokitRequest } from '@octokit/request';
import { RequestError } from '@octokit/request-error';
import { Cause, Data, Duration, Effect } from 'effect';
import { StatusCodes } from 'http-status-codes';
import { Secrets } from '@platform/secrets';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { getGitHubToken } from './githubAuth';

const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

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
 * objects. octokit's RequestError already extracts `message` into its
 * `.message`, but `response.data` may still be the raw object — fall back
 * to a JSON-stringified form if we ever need to format it ourselves.
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

/**
 * Defeat octokit's legacy URI-template colon syntax. `@octokit/endpoint`
 * rewrites `:name` (lowercase letter + word chars) into `{name}` before
 * RFC-6570 expansion; with no matching parameter, the variable expands to
 * the empty string. Our callers pass already-interpolated paths, so any
 * literal colon (e.g. the `head=owner:branch` filter on `/pulls`) would
 * silently truncate the URL. Encode just enough of the colon to escape
 * the legacy rewrite while leaving the rest of the path alone.
 */
function escapeOctokitLegacyTemplate(path: string): string {
  return path.replaceAll(/:([a-z]\w+)/g, '%3A$1');
}

/**
 * Classify a rejected GitHub request: `null` for 304 Not Modified (octokit
 * rejects it, though it is the cached answer), otherwise the failure to
 * report, tagged when it is an HTTP status a caller acts on.
 */
function classifyRequestError(err: unknown): Error | null {
  if (err instanceof RequestError) {
    const status = err.status;
    const responseHeaders = err.response?.headers;
    const responseData = err.response?.data;

    // 304 Not Modified comes through as an error in octokit. Surface it as
    // the cached/unchanged response so callers can distinguish from 4xx.
    if (status === StatusCodes.NOT_MODIFIED) {
      return null;
    }

    if (
      status === StatusCodes.UNAUTHORIZED ||
      status === StatusCodes.FORBIDDEN
    ) {
      // Primary rate limit: x-ratelimit-remaining hits 0 with an
      // epoch-seconds reset timestamp. Only applies when credentials were
      // otherwise valid.
      const remaining = responseHeaders?.['x-ratelimit-remaining'];
      const reset = responseHeaders?.['x-ratelimit-reset'];
      if (remaining === '0' && typeof reset === 'string') {
        return new GitHubRateLimitError({ resetAt: Number(reset) });
      }
      // Secondary / abuse rate limit: 403 with a Retry-After header
      // (seconds from now). Primary-limit headers may still read
      // "non-zero remaining". Without this branch we'd misclassify as an
      // auth error and stop the subscription permanently.
      const retryAfter = responseHeaders?.['retry-after'];
      if (status === StatusCodes.FORBIDDEN && typeof retryAfter === 'string') {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs > 0) {
          return new GitHubRateLimitError({
            resetAt: Math.floor(Date.now() / 1000) + Math.ceil(secs),
          });
        }
      }
      return new GitHubAuthError({
        message: `GitHub returned ${status}: ${extractApiMessage(responseData, err.message)}`,
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
        message: `GitHub returned ${status}: ${extractApiMessage(responseData, err.message)}`,
      });
    }
  }
  // Network-level errors (connection refused, DNS failure) reach here
  // without a response. Answer a plain Error with a human-readable message so
  // callers and the follow-up queue never see SDK internals.
  if (err instanceof Error) {
    return new Error(`GitHub request failed: ${err.message}`);
  }
  return ensureError(err);
}

export const ghGet = Effect.fn('ghGet')(function* <T>(
  path: string,
  etag?: string,
): Effect.fn.Return<ConditionalResponse<T>, Error, Secrets> {
  const secrets = yield* Secrets;
  const token = yield* getGitHubToken(secrets);
  const headers: Record<string, string> = {
    'X-GitHub-Api-Version': API_VERSION,
    'user-agent': 'TeXRA-Extension',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (etag) headers['if-none-match'] = etag;

  let signal: AbortSignal | undefined;
  let pending: ReturnType<typeof octokitRequest> | undefined;
  let primary: { error: unknown } | undefined;
  return yield* Effect.tryPromise({
    try: (interruption) => {
      signal = interruption;
      pending = octokitRequest(`GET ${escapeOctokitLegacyTemplate(path)}`, {
        headers,
        request: { signal: interruption },
      });
      return pending;
    },
    catch: ensureError,
  }).pipe(
    Effect.map((res): ConditionalResponse<T> => ({
      status: 200,
      data: res.data as T,
      etag: res.headers.etag,
    })),
    // The deadline interrupts the request, which aborts its signal.
    Effect.timeout(Duration.millis(TIMEOUT_MS)),
    Effect.catch(
      (
        err: Error | Cause.TimeoutError,
      ): Effect.Effect<ConditionalResponse<T>, Error> => {
        if (Cause.isTimeoutError(err)) {
          return Effect.fail(
            new Error(
              `GitHub request failed (TIMEOUT): request exceeded ${TIMEOUT_MS}ms`,
            ),
          );
        }
        primary = { error: err };
        const failure = classifyRequestError(err);
        return failure === null
          ? Effect.succeed({ status: 304 })
          : Effect.fail(failure);
      },
    ),
    // Effect aborts the request before this uninterruptible join. Octokit's
    // public promise includes body consumption; errors it hides stay hidden.
    Effect.onExit(() => {
      const request = pending;
      return request === undefined
        ? Effect.void
        : Effect.tryPromise({
            try: () => request,
            catch: ensureError,
          }).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              (primary !== undefined && error === primary.error) ||
              (signal?.aborted === true && error === signal.reason)
                ? Effect.void
                : Effect.die(error),
            ),
          );
    }),
  );
});
