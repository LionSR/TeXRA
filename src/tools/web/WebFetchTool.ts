// Node imports
import { lookup } from 'node:dns';

// Third-party imports
import { Effect, Stream } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
} from 'effect/unstable/http';
import ipaddr from 'ipaddr.js';
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';
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
import type { LookupFunction } from 'node:net';

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

const PRIVATE_ADDRESS_REFUSAL =
  'Cannot fetch localhost or private network addresses. Provide a public URL instead.';

/**
 * Default-deny, not a denylist: `ipaddr.js` classifies every address into a
 * named range (`private`, `loopback`, `carrierGradeNat`, `reserved`, …) with
 * `unicast` as the single fallback for none-of-the-above. Blocking everything
 * but `unicast` avoids the incomplete-range-list bypasses that hit hand-rolled
 * checks and even the `ip`/`private-ip` packages (e.g. missing the CGNAT
 * range, or an IPv4-mapped IPv6 literal like `::ffff:127.0.0.1` slipping past
 * an IPv6-only prefix check) — `ipaddr.process` normalizes that mapped form to
 * plain IPv4 before classification, so it is covered too. The NAT64 (DNS64
 * synthesizes `64:ff9b::/96` for an IPv4-only host) and 6to4 ranges carry an
 * IPv4 address, which is what decides them.
 */
function isRestrictedIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.process(address);
  const range = ip.range();
  if (ip.kind() === 'ipv6' && (range === 'rfc6052' || range === '6to4')) {
    const { parts } = ip as ipaddr.IPv6;
    const [high, low] =
      range === 'rfc6052' ? [parts[6], parts[7]] : [parts[1], parts[2]];
    return isRestrictedIp(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }
  return range !== 'unicast';
}

/**
 * The resolver a connection uses: every address a name resolves to must be
 * public, so one private record among several fails the connection. The check
 * and the connect share one answer, so a name that answers differently a
 * moment later (DNS rebinding) cannot reach a private address, and every
 * redirect hop is covered. `net` does not resolve an IP literal, so
 * {@link assertPublicLiteral} covers that form.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address, family);
      return;
    }
    const resolved = [address]
      .flat()
      .map((entry) => (typeof entry === 'string' ? entry : entry.address));
    callback(
      resolved.some(isRestrictedIp)
        ? new ToolError(PRIVATE_ADDRESS_REFUSAL)
        : null,
      address,
      family,
    );
  });

/**
 * Built on first use, as the proxy agent reads the environment when it is
 * constructed. Every direct connection resolves through
 * {@link publicOnlyLookup}: with no proxy configured, for a host `NO_PROXY`
 * exempts, and for a scheme no `*_PROXY` variable covers. A proxied request
 * connects to the proxy, whose connector ignores this `lookup`, so there the
 * proxy resolves the name and only {@link assertPublicLiteral} applies.
 */
let dispatcher: Dispatcher | undefined;

function webFetchDispatcher(): Dispatcher {
  dispatcher ??= new EnvHttpProxyAgent({
    connect: { lookup: publicOnlyLookup },
  });
  return dispatcher;
}

/**
 * undici's own `fetch`, not the global one: the global is the runtime's
 * bundled undici, which rejects a dispatcher built by this package's undici
 * (see `longRunningModelFetch`).
 */
const publicFetch: typeof fetch = (input, init) =>
  undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...init, dispatcher: webFetchDispatcher() } as Parameters<
      typeof undiciFetch
    >[1],
  ) as unknown as Promise<Response>;

/** Refuse an IP-literal host, the one form {@link publicOnlyLookup} never sees. */
function assertPublicLiteral(url: URL) {
  // `URL#hostname` brackets an IPv6 literal, which `ipaddr.isValid` rejects.
  return isRestrictedIp(url.hostname.replaceAll(/^\[|\]$/g, ''))
    ? Effect.fail(new ToolError(PRIVATE_ADDRESS_REFUSAL))
    : Effect.void;
}

/**
 * The resolver's refusal, which reaches the request as the cause of the cause
 * of a transport failure, as a permanent `ToolError` instead of a transient
 * failure the retry would repeat.
 */
function refusalOf(error: HttpClientError.HttpClientError): Error {
  const { reason } = error;
  return reason._tag === 'TransportError' &&
    reason.cause instanceof Error &&
    reason.cause.cause instanceof ToolError
    ? reason.cause.cause
    : error;
}

/**
 * GET `start`, following redirects by hand so every hop's host is checked
 * ({@link publicOnlyLookup}, {@link assertPublicLiteral}): the fetch runs with
 * `redirect: 'manual'`, and a redirect to a private address is the same
 * refusal as asking for it.
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
    yield* assertPublicLiteral(target);
    const response = yield* client.get(target).pipe(
      Effect.provideService(FetchHttpClient.Fetch, publicFetch),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
      Effect.mapError(refusalOf),
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
