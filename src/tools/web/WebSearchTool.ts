// Third-party imports
import ky, { HTTPError } from 'ky';
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';

// Internal imports
import { ensureError, toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@shared/schemas/toolResult';
import { isTimeoutError, isTransientHttpError } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';

const DDG_TIMEOUT_MS = 15_000; // 15 s
const DDG_RETRIES = 2;

const WebSearchInputSchema = z.strictObject({
  query: z
    .string()
    .describe('Search query to send to the web search provider.'),
  max_results: z
    .number()
    .min(1)
    .max(5)
    .nullish()
    .transform((v) => v ?? 3)
    .describe('Maximum number of search results to return, up to 5.'),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

interface DuckDuckGoResult {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoResult[];
}

interface DuckDuckGoResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoResult[];
  Infobox?: {
    content?: Array<{ label?: string; value?: string }>;
  };
}

export class WebSearchTool extends defineTool({
  name: 'web_search',
  description:
    'Search the web and return top results. Uses the native provider search tool when available; falls back to DuckDuckGo Instant Answers API.',
  schema: WebSearchInputSchema,
}) {
  protected async execute(input: WebSearchInput): Promise<ToolResult> {
    const { query, max_results } = input;

    let data: DuckDuckGoResponse;
    try {
      data = await pRetry(
        async () => {
          try {
            const response = await ky.get('https://api.duckduckgo.com/', {
              searchParams: {
                q: query,
                format: 'json',
                no_redirect: 1,
                no_html: 1,
              },
              timeout: false,
              signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
              retry: 0,
            });
            return (await response.json()) as DuckDuckGoResponse;
          } catch (error: unknown) {
            if (isTransientHttpError(error)) throw error;
            throw new AbortError(
              ensureError(error),
            );
          }
        },
        { retries: DDG_RETRIES, minTimeout: 500, randomize: true },
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ToolError(
          `Web search timed out after ${DDG_TIMEOUT_MS / 1000}s. Retry the request.`,
        );
      }
      if (error instanceof HTTPError) {
        throw new ToolError(
          `Web search failed: HTTP ${error.response.status} from DuckDuckGo.`,
        );
      }
      if (error instanceof TypeError) {
        throw new ToolError(
          `Web search failed: network error — ${error.message}`,
        );
      }
      throw new ToolError(`Web search failed: ${toErrorMessage(error)}`);
    }

    const results: string[] = [];

    // Extract abstract/summary if available (direct answers)
    if (data.AbstractText && data.AbstractURL) {
      const source = data.AbstractSource ? ` [${data.AbstractSource}]` : '';
      results.push(`${data.AbstractText}${source} (${data.AbstractURL})`);
    } else if (data.Abstract && data.AbstractURL) {
      results.push(`${data.Abstract} (${data.AbstractURL})`);
    }

    // Extract from RelatedTopics (including nested Topics)
    const extractTopics = (topics: DuckDuckGoResult[], limit: number): void => {
      for (const item of topics) {
        if (results.length >= limit) break;
        if (
          typeof item.Text === 'string' &&
          typeof item.FirstURL === 'string'
        ) {
          results.push(`${item.Text} (${item.FirstURL})`);
        }
        // Handle nested topic groups
        if (Array.isArray(item.Topics)) {
          extractTopics(item.Topics, limit);
        }
      }
    };

    if (Array.isArray(data.RelatedTopics)) {
      extractTopics(data.RelatedTopics, max_results);
    }

    // Extract key facts from Infobox if available
    if (data.Infobox?.content && results.length < max_results) {
      const facts = data.Infobox.content
        .filter((c) => c.label && c.value)
        .slice(0, max_results - results.length)
        .map((c) => `${c.label}: ${c.value}`);
      if (facts.length > 0) {
        results.push(`Key facts: ${facts.join('; ')}`);
      }
    }

    if (results.length === 0) {
      return {
        summary: `Searched: "${query}" (no results)`,
        output:
          'No results found. Note: This search uses DuckDuckGo Instant Answers API which works best for factual/entity queries. For general web searches, try rephrasing the query or use more specific terms.',
      };
    }
    return {
      summary: `Searched: "${query}"`,
      output: results.slice(0, max_results).join('\n\n'),
    };
  }
}
