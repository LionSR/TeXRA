// Third-party imports
import axios from 'axios';
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { zodToJsonSchema } from '@alcyone-labs/zod-to-json-schema';

// Local imports - tools
import { BaseTool } from '../core/base';
import { ToolResult } from '../result';
import type { ToolDefinition } from '@model';

const WebSearchInputSchema = z.object({
  query: z.string(),
  max_results: z.number().min(1).max(5).optional(),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export class WebSearchTool extends BaseTool<WebSearchInput> {
  constructor() {
    const definition: ToolDefinition = {
      name: 'web_search',
      description: 'Search the web and return top results',
      parameters: zodToJsonSchema(WebSearchInputSchema),
    };
    super(definition, WebSearchInputSchema);
  }

  protected async execute(input: WebSearchInput): Promise<ToolResult> {
    const { query, max_results = 3 } = input;
    try {
      const response = await axios.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_redirect: 1, no_html: 1 },
      });
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
        return new ToolResult({ output: 'No results found.' });
      }
      return new ToolResult({ output: results.join('\n') });
    } catch (err) {
      return new ToolResult({
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      });
    }
  }
}
