// Third-party imports
import crossref from 'crossref';
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
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});

export type CrossrefSearchInput = z.infer<typeof CrossrefSearchInputSchema>;

type CrossrefWorksCallback = (
  error: Error | null,
  items?: unknown[],
  nextOptions?: Record<string, unknown>,
  isDone?: boolean,
  message?: Record<string, unknown>,
) => void;

const queryWorks = (options: Record<string, unknown>) =>
  new Promise<{
    items: unknown[];
    nextOptions?: Record<string, unknown>;
    isDone?: boolean;
    message?: Record<string, unknown>;
  }>((resolve, reject) => {
    (
      crossref.works as (
        opts: Record<string, unknown>,
        cb: CrossrefWorksCallback,
      ) => void
    )(options, (error, items, nextOptions, isDone, message) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        items: Array.isArray(items) ? items : [],
        nextOptions,
        isDone,
        message,
      });
    });
  });

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

    const options: Record<string, unknown> = {
      query: trimmedQuery,
    };

    if (typeof input.rows === 'number') {
      options.rows = input.rows;
    }
    if (typeof input.offset === 'number') {
      options.offset = input.offset;
    }
    if (input.sort) {
      options.sort = input.sort;
    }
    if (input.order) {
      options.order = input.order;
    }
    if (input.filter) {
      options.filter = input.filter;
    }

    let response;
    try {
      response = await queryWorks(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Crossref search failed: ${message}`);
    }

    const items = response.items;
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
      const work = item as Record<string, unknown>;
      const titleValue = work.title;
      const primaryTitle = Array.isArray(titleValue)
        ? titleValue[0]
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
        typeof response.message?.['total-results'] === 'number'
          ? response.message['total-results']
          : null,
      nextOptions: response.isDone ? null : (response.nextOptions ?? null),
      results,
    };

    return toolResult({
      summary: `Found ${results.length} Crossref result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
