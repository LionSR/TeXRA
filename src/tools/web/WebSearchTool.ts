// Third-party imports
import axios from 'axios';
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from '../core/define';

// Local imports - tools
import { ToolResult, ToolError, toolResult } from '../result';

const WebSearchInputSchema = z.object({
  query: z.string(),
  max_results: z.number().min(1).max(5).optional(),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export class WebSearchTool extends defineTool({
  name: 'web_search',
  description: 'Search the web and return top results',
  schema: WebSearchInputSchema,
}) {
  protected async execute(input: WebSearchInput): Promise<ToolResult> {
    const { query, max_results = 3 } = input;
    let response;
    try {
      response = await axios.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_redirect: 1, no_html: 1 },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Web search failed: ${message}`);
    }
    const data = response.data;
    const results: string[] = [];
    if (Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics.slice(0, max_results)) {
        if (
          typeof item.Text === 'string' &&
          typeof item.FirstURL === 'string'
        ) {
          results.push(`${item.Text} (${item.FirstURL})`);
        }
      }
    }
    if (results.length === 0) {
      return toolResult({
        summary: `Search "${query}" (no results)`,
        output: 'No results found.',
      });
    }
    return toolResult({
      summary: `Search "${query}"`,
      output: results.join('\n'),
    });
  }
}
