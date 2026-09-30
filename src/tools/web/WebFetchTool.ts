// Node imports
import { lookup } from 'node:dns/promises';

// Third-party imports
import { Effect, Stream } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';

// Local imports - core
import { ToolError } from '@shared/schemas';
import {
  retryTransientFetch,
  scopedClient,
  toFetchToolError,
} from '@tools/timeouts';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { createHtmlToMarkdown } from '@utils/text/htmlToMarkdown';
import { formatBytes } from '@utils/text/stringUtils';

const WEB_FETCH_TIMEOUT_MS = 30_000; // 30 s
const WEB_FETCH_RETRIES = 2;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_REDIRECTS = 5;

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

/**
 * Default-deny, not a denylist: `ipaddr.js` classifies every address into a
 * named range (`private`, `loopback`, `carrierGradeNat`, `reserved`, …) with
 * `unicast` as the single fallback for none-of-the-above. Blocking everything
 * but `unicast` avoids the incomplete-range-list bypasses that hit hand-rolled
 * checks and even the `ip`/`private-ip` packages (e.g. missing the CGNAT
 * range, or an IPv4-mapped IPv6 literal like `::ffff:127.0.0.1` slipping past
 * an IPv6-only prefix check) — `ipaddr.process` normalizes that mapped form to
 * plain IPv4 before classification, so it is covered too.
 */
function isRestrictedIp(address: string): boolean {
  return (
    ipaddr.isValid(address) && ipaddr.process(address).range() !== 'unicast'
  );
}

/**
 * Refuse a URL whose host is, or resolves to, a non-public address. The name
 * is resolved here because the host string alone says nothing (`localhost.`,
 * a public name with a loopback A record); every address it resolves to must
 * be public, so one private record among several fails the call. `hostname`
 * is a WHATWG `URL#hostname`, which brackets an IPv6 literal (`[::1]`) and
 * `ipaddr.isValid` rejects the bracketed form, so the brackets come off first.
 * The fetch resolves the name again, so this narrows DNS rebinding rather than
 * closing it.
 */
const assertPublicHost = Effect.fn('WebFetchTool.assertPublicHost')(function* (
  url: URL,
) {
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host)
    ? [host]
    : (yield* Effect.tryPromise({
        try: () => lookup(host, { all: true }),
        catch: (error) =>
          new ToolError(`Cannot resolve ${host}: ${toErrorMessage(error)}`),
      })).map(({ address }) => address);
  if (addresses.some(isRestrictedIp)) {
    return yield* Effect.fail(
      new ToolError(
        'Cannot fetch localhost or private network addresses. Provide a public URL instead.',
      ),
    );
  }
});

/**
 * GET `start`, following redirects by hand so every hop's host passes
 * {@link assertPublicHost}: the fetch runs with `redirect: 'manual'`, and a
 * redirect to a private address is the same refusal as asking for it.
 */
const getPublic = Effect.fn('WebFetchTool.getPublic')(function* (
  start: string,
) {
  const client = HttpClient.filterStatus(
    yield* scopedClient,
    (status) => status >= 200 && status < 400,
  );
  let target = new URL(start);
  for (let redirects = 0; ; redirects++) {
    yield* assertPublicHost(target);
    const response = yield* client.get(target).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
    );
    if (response.status < 300) return response;
    const { location } = response.headers;
    if (!location || redirects >= MAX_REDIRECTS) {
      return yield* Effect.fail(
        new ToolError(
          location
            ? `Too many redirects (more than ${MAX_REDIRECTS}).`
            : `HTTP ${response.status} redirect without a Location header.`,
        ),
      );
    }
    target = new URL(location, target);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return yield* Effect.fail(
        new ToolError(`Redirect to a non-HTTP URL: ${target.protocol}`),
      );
    }
  }
});

/** Fetch `url` with transient retries, as text plus its content type. */
const fetchPage = Effect.fn('WebFetchTool.fetchPage')((url: string) =>
  retryTransientFetch(
    Effect.gen(function* () {
      // One attempt owns headers and body together: the request scope stays
      // open through the body read.
      const response = yield* getPublic(url);

      const lengthHeader = response.headers['content-length'];
      if (lengthHeader && Number(lengthHeader) > MAX_CONTENT_BYTES) {
        // Permanent: not retried.
        return yield* Effect.fail(
          new Error(
            `Response too large (${lengthHeader} bytes); maximum is ${formatBytes(MAX_CONTENT_BYTES)}.`,
          ),
        );
      }

      const contentType = response.headers['content-type'] ?? '';
      const charset = /charset=([^\s;]+)/i
        .exec(contentType)?.[1]
        ?.replaceAll(/^["']|["']$/gu, '');
      // Unsupported labels fall back to UTF-8, as for an absent charset.
      const decoder = yield* Effect.try({
        try: () => new TextDecoder(charset || 'utf-8'),
        catch: ensureError,
      }).pipe(Effect.orElseSucceed(() => new TextDecoder()));
      let total = 0;
      const parts = yield* response.stream.pipe(
        // A response without a body reads as empty text.
        Stream.catchReason(
          'HttpClientError',
          'EmptyBodyError',
          () => Stream.empty,
        ),
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
      error instanceof ToolError
        ? error
        : toFetchToolError(error, {
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
  replay: 'safe',
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
