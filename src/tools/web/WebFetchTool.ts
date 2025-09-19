// Third-party imports
import axios from 'axios';
import TurndownService from 'turndown';
import { z } from 'zod';

// Local imports - core
import { defineTool } from '../core/define';

// Local imports - tools
import { ToolError, ToolResult } from '../result';

const WebFetchInputSchema = z
  .object({
    url: z.string().url('Provide a valid absolute URL to fetch.'),
    prompt: z.string().min(1).optional(),
  })
  .strict();

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export class WebFetchTool extends defineTool({
  name: 'web_fetch',
  description:
    'Retrieve the HTML at a given URL, convert it to Markdown, and return the cleaned text. Include an optional prompt to explain what context you need so the fetched content can be interpreted correctly.',
  schema: WebFetchInputSchema,
}) {
  private readonly turndown = new TurndownService({ headingStyle: 'atx' });

  protected async execute(input: WebFetchInput): Promise<ToolResult> {
    const { url, prompt } = input;

    let response;
    try {
      response = await axios.get(url, { responseType: 'text' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to fetch ${url}: ${message}`);
    }

    const rawBody =
      typeof response.data === 'string'
        ? response.data
        : Buffer.isBuffer(response.data)
          ? response.data.toString('utf8')
          : String(response.data ?? '');

    const contentType = String(
      response.headers?.['content-type'] ?? '',
    ).toLowerCase();
    const shouldConvertToMarkdown =
      contentType.includes('html') || contentType.includes('xml');

    let markdown: string;
    if (shouldConvertToMarkdown) {
      try {
        markdown = this.turndown.turndown(rawBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Failed to convert HTML to Markdown: ${message}`);
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

    return new ToolResult({ output: sections.join('\n\n') });
  }
}
