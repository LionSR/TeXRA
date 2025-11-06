// Third-party imports
import {
  CrossrefClient,
  SortOrder,
  type QueryWorksParams,
  type WorkSortOptions,
} from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const CrossrefSearchInputSchema = z.strictObject({
  query: z.string(),
  rows: z.number().int().positive().max(100).optional(),
  offset: z.number().int().min(0).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  filter: z
    .union([
      z.string(),
      z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    ])
    .optional(),
});

export type CrossrefSearchInput = z.infer<typeof CrossrefSearchInputSchema>;

const crossrefClient = new CrossrefClient();
type ExtendedQueryWorksParams = QueryWorksParams & { filter?: string };

export class CrossrefSearchTool extends defineTool({
  name: 'crossref_search',
  description: 'Search Crossref works and return top matches.',
  schema: CrossrefSearchInputSchema,
}) {
  protected async execute(input: CrossrefSearchInput) {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      throw new ToolError('Search query cannot be empty.');
    }

    const options: ExtendedQueryWorksParams = {
      query: trimmedQuery,
    };

    if (typeof input.rows === 'number') {
      options.rows = input.rows;
    }
    if (typeof input.offset === 'number') {
      options.offset = input.offset;
    }
    if (input.sort) {
      options.sort = input.sort as WorkSortOptions;
    }
    if (input.order) {
      options.order = input.order === 'asc' ? SortOrder.ASC : SortOrder.DESC;
    }
    if (input.filter) {
      if (typeof input.filter === 'string') {
        options.filter = input.filter;
      } else {
        const segments = Object.entries(input.filter).flatMap(([key, value]) =>
          Array.isArray(value)
            ? value.map((entry) => `${key}:${entry}`)
            : [`${key}:${value}`],
        );
        options.filter = segments.join(',');
      }
    }

    let response: Awaited<ReturnType<typeof crossrefClient.works>>;
    try {
      response = await crossrefClient.works(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Crossref search failed: ${message}`);
    }

    if (!response.ok || !response.content || !response.content.message) {
      throw new ToolError('Crossref search did not return any items.');
    }

    const message = response.content.message;
    const items = Array.isArray(message.items) ? message.items : [];

    const results = items.map((item) => {
      if (!item || typeof item !== 'object') {
        return {
          title: null,
          doi: null,
          publisher: null,
          type: null,
          issued: null,
          url: null,
        };
      }
      const work = item as unknown as Record<string, unknown>;
      const titleValue = work.title;
      const primaryTitle = Array.isArray(titleValue)
        ? (titleValue.find((entry) => typeof entry === 'string') ?? null)
        : typeof titleValue === 'string'
          ? titleValue
          : null;

      return {
        title: primaryTitle,
        doi: typeof work.DOI === 'string' ? work.DOI : null,
        publisher: typeof work.publisher === 'string' ? work.publisher : null,
        type: typeof work.type === 'string' ? work.type : null,
        issued: work.issued ?? null,
        url: typeof work.URL === 'string' ? work.URL : null,
      };
    });

    const payload = {
      query: trimmedQuery,
      count: results.length,
      totalResults:
        typeof message.totalResults === 'number' ? message.totalResults : null,
      nextOptions: null,
      results,
    };

    return toolResult({
      summary: `Found ${results.length} Crossref result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
