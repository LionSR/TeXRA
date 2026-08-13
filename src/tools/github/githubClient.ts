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
import { StatusCodes } from 'http-status-codes';
import { isNonEmptyString } from '@utils/core';

import { getGitHubToken } from './githubAuth';

const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

export type ConditionalResponse<T> =
  { status: 200; data: T; etag: string | undefined } | { status: 304 };

export class GitHubAuthError extends Error {
  constructor(message = 'GitHub authentication failed') {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubRateLimitError extends Error {
  constructor(public readonly resetAt: number) {
    super(
      `GitHub rate limit exceeded; resets at ${new Date(resetAt * 1000).toISOString()}`,
    );
    this.name = 'GitHubRateLimitError';
  }
}

/** Thrown for HTTP statuses that won't recover on retry (404, 410, 422). */
export class GitHubPermanentError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubPermanentError';
  }
}

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

export async function ghGet<T>(
  path: string,
  etag?: string,
): Promise<ConditionalResponse<T>> {
  const token = await getGitHubToken();
  const headers: Record<string, string> = {
    'X-GitHub-Api-Version': API_VERSION,
    'user-agent': 'TeXRA-Extension',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (etag) headers['if-none-match'] = etag;

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await octokitRequest(
      `GET ${escapeOctokitLegacyTemplate(path)}`,
      {
        headers,
        request: { signal },
      },
    );
    const newEtag = res.headers.etag as string | undefined;
    return { status: 200, data: res.data as T, etag: newEtag };
  } catch (err) {
    if (err instanceof RequestError) {
      const status = err.status;
      const responseHeaders = err.response?.headers;
      const responseData = err.response?.data;

      // 304 Not Modified comes through as an error in octokit. Surface it as
      // the cached/unchanged response so callers can distinguish from 4xx.
      if (status === StatusCodes.NOT_MODIFIED) return { status: 304 };

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
          throw new GitHubRateLimitError(Number(reset));
        }
        // Secondary / abuse rate limit: 403 with a Retry-After header
        // (seconds from now). Primary-limit headers may still read
        // "non-zero remaining". Without this branch we'd misclassify as an
        // auth error and stop the subscription permanently.
        const retryAfter = responseHeaders?.['retry-after'];
        if (
          status === StatusCodes.FORBIDDEN &&
          typeof retryAfter === 'string'
        ) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs) && secs > 0) {
            throw new GitHubRateLimitError(
              Math.floor(Date.now() / 1000) + Math.ceil(secs),
            );
          }
        }
        throw new GitHubAuthError(
          `GitHub returned ${status}: ${extractApiMessage(responseData, err.message)}`,
        );
      }
      // Permanent HTTP failures — retrying won't help; surface immediately so
      // callers can halt rather than burning a slot for 24 h.
      if (
        status === StatusCodes.NOT_FOUND ||
        status === StatusCodes.GONE ||
        status === StatusCodes.UNPROCESSABLE_ENTITY
      ) {
        throw new GitHubPermanentError(
          status,
          `GitHub returned ${status}: ${extractApiMessage(responseData, err.message)}`,
        );
      }
    }
    // Network-level errors (timeout, connection refused, DNS failure) reach
    // here without a response. Re-throw a plain Error with a human-readable
    // message so callers and the follow-up queue never see SDK internals.
    if (signal.aborted) {
      throw new Error(
        `GitHub request failed (TIMEOUT): request exceeded ${TIMEOUT_MS}ms`,
      );
    }
    if (err instanceof Error) {
      throw new Error(`GitHub request failed: ${err.message}`);
    }
    throw err;
  }
}
