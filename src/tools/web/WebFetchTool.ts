// Third-party imports
import { Effect, Stream } from 'effect';
import ipaddr from 'ipaddr.js';
import ky from 'ky';
import { z } from 'zod';

// Local imports - core
import { ToolError } from '@shared/schemas';
import { retryTransientFetch, toFetchToolError } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { createHtmlToMarkdown } from '@utils/text/htmlToMarkdown';
import { formatBytes } from '@utils/text/stringUtils';

const WEB_FETCH_TIMEOUT_MS = 30_000; // 30 s
const WEB_FETCH_RETRIES = 2;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MiB

const WebFetchInputSchema = z.strictObject({
  url: z
    .url('Provide a valid absolute URL to fetch.')
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      'URL must use HTTP or HTTPS protocol',
    )
    .describe('Public HTTP or HTTPS URL to fetch.'),
  prompt: z
    .string()
    .min(1)
    .nullish()
    .describe('Optional instruction describing what to extract from the page.'),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * Default-deny, not a denylist: `ipaddr.js` classifies every address into a
 * named range (`private`, `loopback`, `carrierGradeNat`, `reserved`, …) with
 * `unicast` as the single fallback for none-of-the-above. Blocking everything
 * but `unicast` avoids the incomplete-range-list bypasses that hit hand-rolled
 * checks and even the `ip`/`private-ip` packages (e.g. missing the CGNAT
 * range, or an IPv4-mapped IPv6 literal like `::ffff:127.0.0.1` slipping past
 * an IPv6-only prefix check) — `ipaddr.process` normalizes that mapped form to
 * plain IPv4 before classification, so it is covered too.
 *
 * `hostname` is a WHATWG `URL#hostname`, which brackets an IPv6 literal
 * (`[::1]`); `ipaddr.isValid` rejects the bracketed form outright, so an
 * unstripped hostname would fail open on every IPv6 target.
 */
function isRestrictedIp(hostname: string): boolean {
  const candidate =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (!ipaddr.isValid(candidate)) return false;
  return ipaddr.process(candidate).range() !== 'unicast';
}

/** Fetch `url` with transient retries, as text plus its content type. */
const fetchPage = Effect.fn('WebFetchTool.fetchPage')((url: string) =>
  retryTransientFetch(
    Effect.gen(function* () {
      // One attempt owns headers and body together; its signal must remain
      // live after ky resolves the response headers.
      const signal = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise({
        try: () => ky.get(url, { timeout: false, signal, retry: 0 }),
        catch: ensureError,
      });

      const lengthHeader = response.headers.get('content-length');
      if (lengthHeader && Number(lengthHeader) > MAX_CONTENT_BYTES) {
        // Permanent: not retried.
        return yield* Effect.fail(
          new Error(
            `Response too large (${lengthHeader} bytes); maximum is ${formatBytes(MAX_CONTENT_BYTES)}.`,
          ),
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      const body = response.body;
      if (!body) return { rawBody: '', contentType };
      const charset = /charset=([^\s;]+)/i
        .exec(contentType)?.[1]
        ?.replaceAll(/^["']|["']$/gu, '');
      // Unsupported labels fall back to UTF-8, as for an absent charset.
      const decoder = yield* Effect.try({
        try: () => new TextDecoder(charset || 'utf-8'),
        catch: ensureError,
      }).pipe(Effect.orElseSucceed(() => new TextDecoder()));
      let total = 0;
      const parts = yield* Stream.fromReadableStream({
        evaluate: () => body,
        onError: ensureError,
        releaseLockOnEnd: true,
      }).pipe(
        Stream.mapEffect((chunk) => {
          // Count received bytes even when Content-Length is absent or wrong.
          total += chunk.byteLength;
          if (total > MAX_CONTENT_BYTES) {
            return Effect.fail(
              new Error(
                `Response too large (exceeds ${formatBytes(MAX_CONTENT_BYTES)} maximum).`,
              ),
            );
          }
          return Effect.try({
            try: () => decoder.decode(chunk, { stream: true }),
            catch: ensureError,
          });
        }),
        Stream.runCollect,
      );
      // Flush incomplete trailing code units too; streaming decode alone
      // would silently omit their replacement characters.
      parts.push(
        yield* Effect.try({
          try: () => decoder.decode(),
          catch: ensureError,
        }),
      );
      return { rawBody: parts.join(''), contentType };
    }),
    {
      retries: WEB_FETCH_RETRIES,
      minTimeout: 500,
      timeoutMs: WEB_FETCH_TIMEOUT_MS,
    },
  ).pipe(
    Effect.mapError((error) =>
      toFetchToolError(error, {
        timeout:
          `Request to ${url} timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s. ` +
          `The remote server did not respond in time. Retry the request, or try a different URL.`,
        http: (status) => `HTTP ${status}: Failed to fetch ${url}`,
        network: (message) => `Network error fetching ${url}: ${message}`,
        fallback: (message) => `Failed to fetch ${url}: ${message}`,
      }),
    ),
  ),
);

const turndown = createHtmlToMarkdown();

const fetchAsMarkdown = Effect.fn('WebFetchTool.execute')(function* ({
  url,
  prompt,
}: WebFetchInput) {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return yield* Effect.fail(
      new ToolError(
        'Cannot fetch localhost URLs. Provide a public URL instead.',
      ),
    );
  }

  if (isRestrictedIp(hostname)) {
    return yield* Effect.fail(
      new ToolError(
        'Cannot fetch private network IPs. Provide a public URL instead.',
      ),
    );
  }

  const { rawBody, contentType } = yield* fetchPage(url);

  const ctLower = contentType.toLowerCase();
  const isMarkupContent =
    ctLower.includes('html') ||
    ctLower.includes('xml') ||
    ctLower.includes('xhtml') ||
    (!contentType && rawBody.trim().startsWith('<'));

  const markdown = isMarkupContent
    ? yield* Effect.try({
        try: () => turndown.turndown(rawBody),
        catch: (error) =>
          new ToolError(
            `Failed to convert HTML to Markdown: ${toErrorMessage(error)}`,
          ),
      })
    : rawBody;

  const cleaned = markdown.trim();
  const sections = [
    ...(prompt ? [`Prompt\n------\n${prompt.trim()}`] : []),
    cleaned.length > 0
      ? cleaned
      : 'No readable content was extracted from the provided URL.',
  ];

  return executed(sections.join('\n\n'), `Fetched: ${url}`);
});

export const WebFetchTool = defineTool({
  name: 'web_fetch',
  slow: true,
  parallelSafe: true,
  description:
    'Fetch content from a URL and return it as clean text. Fetches the HTML and converts it to Markdown locally. Include an optional prompt to explain what context you need so the fetched content can be interpreted correctly.',
  schema: WebFetchInputSchema,
  // The owning agent run's cancellation enters here as interruption —
  // without it, a cancelled run would wait out fetches (and their retries)
  // that only observe the internal timeout.
  execute: fetchAsMarkdown,
});
