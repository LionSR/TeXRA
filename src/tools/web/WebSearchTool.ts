// Third-party imports
import axios from 'axios';
import { z } from 'zod';

// Internal imports
import { toErrorMessage } from '@common/errors';
import { ToolResult, ToolError, toolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const WebSearchInputSchema = z.strictObject({
  query: z.string(),
  max_results: z.number().min(1).max(5).nullish(),
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
  description: 'Search the web and return top results',
  schema: WebSearchInputSchema,
}) {
  protected async execute(input: WebSearchInput): Promise<ToolResult> {
    const { query } = input;
    const max_results = input.max_results ?? 3;
    let response;
    try {
      response = await axios.get<DuckDuckGoResponse>(
        'https://api.duckduckgo.com/',
        {
          params: { q: query, format: 'json', no_redirect: 1, no_html: 1 },
        },
      );
    } catch (error) {
      throw new ToolError(`Web search failed: ${toErrorMessage(error)}`);
    }
    const data = response.data;
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
      return toolResult({
        summary: `Search "${query}" (no results)`,
        output:
          'No results found. Note: This search uses DuckDuckGo Instant Answers API which works best for factual/entity queries. For general web searches, try rephrasing the query or use more specific terms.',
      });
    }
    return toolResult({
      summary: `Search "${query}"`,
      output: results.slice(0, max_results).join('\n\n'),
    });
  }
}
