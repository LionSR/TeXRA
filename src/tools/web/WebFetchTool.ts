// Node.js imports
import { isIP } from 'node:net';

// Third-party imports
import axios from 'axios';
import { StatusCodes } from 'http-status-codes';
import TurndownService from 'turndown';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const WebFetchInputSchema = z.strictObject({
  url: z
    .url('Provide a valid absolute URL to fetch.')
    .refine(
      (value) => value.startsWith('http://') || value.startsWith('https://'),
      'URL must use HTTP or HTTPS protocol',
    ),
  prompt: z.string().min(1).nullish(),
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
    'Retrieve the HTML at a given URL, convert it to Markdown, and return the cleaned text. Include an optional prompt to explain what context you need so the fetched content can be interpreted correctly.',
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
      throw new ToolError('Fetching from localhost is not allowed');
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      const isPrivateIp = PRIVATE_IPV4_PATTERNS.some((pattern) =>
        pattern.test(hostname),
      );
      if (isPrivateIp) {
        throw new ToolError(
          'Fetching from private network ranges is not allowed',
        );
      }
    } else if (ipVersion === 6) {
      if (PRIVATE_IPV6_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
        throw new ToolError(
          'Fetching from private network ranges is not allowed',
        );
      }
    }

    let response;
    try {
      response = await axios.get(url, {
        responseType: 'text',
        timeout: 30_000,
        maxRedirects: 5,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
        validateStatus: (status) =>
          status >= StatusCodes.OK && status < StatusCodes.BAD_REQUEST,
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          throw new ToolError(
            `HTTP ${error.response.status}: Failed to fetch ${url}`,
          );
        }

        if (error.request) {
          throw new ToolError(
            `Network error fetching ${url}: ${error.message}`,
          );
        }
      }

      throw new ToolError(`Failed to fetch ${url}: ${toErrorMessage(error)}`);
    }

    const rawBody = response.data;

    const contentType = String(
      response.headers?.['content-type'] ?? '',
    ).toLowerCase();
    const shouldConvertToMarkdown =
      contentType.includes('html') ||
      contentType.includes('xml') ||
      contentType.includes('xhtml') ||
      (!contentType && rawBody.trim().startsWith('<'));

    let markdown: string;
    if (shouldConvertToMarkdown) {
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
      summary: `Fetched ${url}`,
      output: sections.join('\n\n'),
    };
  }
}
