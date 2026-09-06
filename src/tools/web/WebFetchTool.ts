// Node.js imports
import { isIP } from 'node:net';

// Third-party imports
import { Effect, Stream } from 'effect';
import ky from 'ky';
import { z } from 'zod';

// Local imports - core
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { effectRuntime } from '@platform/processRuntime';
import { ToolError, ToolResult } from '@shared/schemas';
import { retryTransientFetch, toFetchToolError } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { createHtmlToMarkdown } from '@utils/text/htmlToMarkdown';

const WEB_FETCH_TIMEOUT_MS = 30_000; // 30 s
const WEB_FETCH_RETRIES = 2;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MB

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

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const PRIVATE_IPV4_PATTERNS = [
  /^10\./u,
  /^192\.168\./u,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./u,
  /^169\.254\./u,
];
const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe80'];

/** Fetch `url` with transient retries, as text plus its content type. */
const fetchPage = Effect.fn('WebFetchTool.fetchPage')((url: string) =>
  retryTransientFetch(
    Effect.gen(function* () {
      // One attempt owns headers and body together; its signal must remain
      // live after ky resolves the response headers.
      const signal = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise({
        try: () => ky.get(url, { timeout: false, signal, retry: 0 }),
        catch: (error) => error,
      });

      const lengthHeader = response.headers.get('content-length');
      if (lengthHeader && Number(lengthHeader) > MAX_CONTENT_BYTES) {
        // Permanent: not retried.
        return yield* Effect.fail(
          new Error(
            `Response too large (${lengthHeader} bytes); maximum is ${MAX_CONTENT_BYTES / (1024 * 1024)} MB.`,
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
      const decoder = yield* Effect.try(
        () => new TextDecoder(charset || 'utf-8'),
      ).pipe(Effect.orElseSucceed(() => new TextDecoder()));
      let total = 0;
      const parts = yield* Stream.fromReadableStream({
        evaluate: () => body,
        onError: (error) => error,
        releaseLockOnEnd: true,
      }).pipe(
        Stream.mapEffect((chunk) => {
          // Count received bytes even when Content-Length is absent or wrong.
          total += chunk.byteLength;
          if (total > MAX_CONTENT_BYTES) {
            return Effect.fail(
              new Error(
                `Response too large (exceeds ${MAX_CONTENT_BYTES / (1024 * 1024)} MB maximum).`,
              ),
            );
          }
          return Effect.try({
            try: () => decoder.decode(chunk, { stream: true }),
            catch: (error) => error,
          });
        }),
        Stream.runCollect,
      );
      // Flush incomplete trailing code units too; streaming decode alone
      // would silently omit their replacement characters.
      parts.push(
        yield* Effect.try({
          try: () => decoder.decode(),
          catch: (error) => error,
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

export class WebFetchTool extends defineTool({
  name: 'web_fetch',
  slow: true,
  parallelSafe: true,
  description:
    'Fetch content from a URL and return it as clean text. Uses the native provider fetch tool when available; falls back to fetching HTML and converting to Markdown locally. Include an optional prompt to explain what context you need so the fetched content can be interpreted correctly.',
  schema: WebFetchInputSchema,
}) {
  private readonly turndown = createHtmlToMarkdown();

  private readonly fetchAsMarkdown = Effect.fn('WebFetchTool.execute')(
    { self: this },
    function* (this: WebFetchTool, { url, prompt }: WebFetchInput) {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();
      if (BLOCKED_HOSTNAMES.has(hostname)) {
        return yield* Effect.fail(
          new ToolError(
            'Cannot fetch localhost URLs. Provide a public URL instead.',
          ),
        );
      }

      const ipVersion = isIP(hostname);
      const isPrivateIp =
        (ipVersion === 4 &&
          PRIVATE_IPV4_PATTERNS.some((p) => p.test(hostname))) ||
        (ipVersion === 6 &&
          PRIVATE_IPV6_PREFIXES.some((prefix) => hostname.startsWith(prefix)));
      if (isPrivateIp) {
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

      let markdown: string;
      if (isMarkupContent) {
        markdown = yield* Effect.try({
          try: () => this.turndown.turndown(rawBody),
          catch: (error) =>
            new ToolError(
              `Failed to convert HTML to Markdown: ${toErrorMessage(error)}`,
            ),
        });
      } else {
        markdown = rawBody;
      }

      const cleaned = markdown.trim();
      const sections: string[] = [];

      if (prompt) {
        sections.push(`Prompt\n------\n${prompt.trim()}`);
      }

      if (cleaned.length > 0) {
        sections.push(cleaned);
      } else {
        sections.push(
          'No readable content was extracted from the provided URL.',
        );
      }

      return executed(sections.join('\n\n'), `Fetched: ${url}`);
    },
  );

  protected execute(input: WebFetchInput): Promise<ToolResult> {
    // The owning agent run's cancellation enters here as interruption —
    // without it, a cancelled run would wait out fetches (and their retries)
    // that only observe the internal timeout.
    return effectRuntime().runPromise(this.fetchAsMarkdown(input), {
      signal: getCurrentToolCallContext()?.signal,
    });
  }
}
