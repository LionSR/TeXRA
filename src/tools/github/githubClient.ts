/**
 * Minimal GitHub REST client with ETag-based conditional requests.
 *
 * We only need a handful of read-only endpoints for PR polling; rather than
 * pulling in @octokit, this ~60-line wrapper covers everything: auth header,
 * ETag/304 handling, and JSON parsing. The caller holds the per-resource ETag
 * and passes it back on subsequent requests.
 */

import axios, { type AxiosError } from 'axios';

import { getGitHubToken } from './githubAuth';

const BASE = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

export type ConditionalResponse<T> =
  | { status: 200; data: T; etag: string | undefined }
  | { status: 304 };

export class GitHubAuthError extends Error {
  constructor(message = 'GitHub authentication failed') {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubRateLimitError extends Error {
  constructor(public readonly resetAt: number) {
    super(`GitHub rate limit exceeded; resets at ${new Date(resetAt * 1000).toISOString()}`);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * GitHub error responses are `{ message, documentation_url, ... }` JSON
 * objects. Raw `String(obj)` would render as `[object Object]`; extract the
 * message field if present, otherwise fall back to a JSON-stringified form.
 */
function extractApiMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object') {
    const rec = data as { message?: unknown };
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
    try {
      return JSON.stringify(data);
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function ghGet<T>(
  path: string,
  etag?: string,
): Promise<ConditionalResponse<T>> {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    Accept: ACCEPT,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'TeXRA-Extension',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;

  try {
    const res = await axios.get<T>(`${BASE}${path}`, {
      headers,
      timeout: TIMEOUT_MS,
      // Accept 304 as a non-error so we can differentiate from 4xx.
      validateStatus: (s) => s === 200 || s === 304,
    });
    if (res.status === 304) return { status: 304 };
    const newEtag = (res.headers?.etag as string | undefined) ?? undefined;
    return { status: 200, data: res.data, etag: newEtag };
  } catch (err) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    if (status === 401 || status === 403) {
      // 403 can also mean rate-limit; distinguish via header.
      const remaining = ax.response?.headers?.['x-ratelimit-remaining'];
      const reset = ax.response?.headers?.['x-ratelimit-reset'];
      if (remaining === '0' && typeof reset === 'string') {
        throw new GitHubRateLimitError(Number(reset));
      }
      throw new GitHubAuthError(
        `GitHub returned ${status}: ${extractApiMessage(ax.response?.data, ax.message)}`,
      );
    }
    throw err;
  }
}
