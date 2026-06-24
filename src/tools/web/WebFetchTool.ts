// Node.js imports
import { isIP } from 'node:net';

// Third-party imports
import ky, { HTTPError } from 'ky';
import pRetry, { AbortError } from 'p-retry';
import TurndownService from 'turndown';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@shared/schemas/toolResult';
import { isTimeoutError, isTransientHttpError } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';

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

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const PRIVATE_IPV4_PATTERNS = [
  /^10\./u,
  /^192\.168\./u,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./u,
  /^169\.254\./u,
];
const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe80'];

export class WebFetchTool extends defineTool({
  name: 'web_fetch',
  description:
    'Fetch content from a URL and return it as clean text. Uses the native provider fetch tool when available; falls back to fetching HTML and converting to Markdown locally. Include an optional prompt to explain what context you need so the fetched content can be interpreted correctly.',
  schema: WebFetchInputSchema,
}) {
  private readonly turndown: TurndownService;

  constructor(turndownOptions?: TurndownService.Options) {
    super();
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      ...turndownOptions,
    });
  }

  protected async execute(input: WebFetchInput): Promise<ToolResult> {
    const { url, prompt } = input;

    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new ToolError(
        'Cannot fetch localhost URLs. Provide a public URL instead.',
      );
    }

    const ipVersion = isIP(hostname);
    const isPrivateIp =
      (ipVersion === 4 &&
        PRIVATE_IPV4_PATTERNS.some((p) => p.test(hostname))) ||
      (ipVersion === 6 &&
        PRIVATE_IPV6_PREFIXES.some((prefix) => hostname.startsWith(prefix)));
    if (isPrivateIp) {
      throw new ToolError(
        'Cannot fetch private network IPs. Provide a public URL instead.',
      );
    }

    let rawBody: string;
    let contentType: string;

    try {
      ({ rawBody, contentType } = await pRetry(
        async (): Promise<{ rawBody: string; contentType: string }> => {
          let response: Response;
          try {
            // AbortSignal.timeout covers both connection and body read;
            // ky's own timeout only clears once headers arrive.
            response = await ky.get(url, {
              timeout: false,
              signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
              retry: 0,
            });
          } catch (error: unknown) {
            if (isTransientHttpError(error)) throw error;
            throw new AbortError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          const lengthHeader = response.headers.get('content-length');
          if (lengthHeader && Number(lengthHeader) > MAX_CONTENT_BYTES) {
            throw new AbortError(
              `Response too large (${lengthHeader} bytes); maximum is ${MAX_CONTENT_BYTES / (1024 * 1024)} MB.`,
            );
          }

          const ct = response.headers.get('content-type') ?? '';
          const text = await response.text();
          return { rawBody: text, contentType: ct };
        },
        { retries: WEB_FETCH_RETRIES, minTimeout: 500, randomize: true },
      ));
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ToolError(
          `Request to ${url} timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s. ` +
            `The remote server did not respond in time. Retry the request, or try a different URL.`,
        );
      }
      if (error instanceof HTTPError) {
        throw new ToolError(
          `HTTP ${error.response.status}: Failed to fetch ${url}`,
        );
      }
      if (error instanceof TypeError) {
        throw new ToolError(`Network error fetching ${url}: ${error.message}`);
      }
      throw new ToolError(`Failed to fetch ${url}: ${toErrorMessage(error)}`);
    }

    const isMarkupContent =
      contentType.includes('html') ||
      contentType.includes('xml') ||
      contentType.includes('xhtml') ||
      (!contentType && rawBody.trim().startsWith('<'));

    let markdown: string;
    if (isMarkupContent) {
      try {
        markdown = this.turndown.turndown(rawBody);
      } catch (error) {
        throw new ToolError(
          `Failed to convert HTML to Markdown: ${toErrorMessage(error)}`,
        );
      }
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
      sections.push('No readable content was extracted from the provided URL.');
    }

    return {
      summary: `Fetched: ${url}`,
      output: sections.join('\n\n'),
    };
  }
}
