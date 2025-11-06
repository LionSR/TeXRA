// Third-party imports
import {
  CrossrefClient,
  SortOrder,
  type QueryWorksParams,
  type WorkSortOptions,
} from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - metadata
import { CROSSREF_CONSTANTS } from './constants';
import { waitForRateLimit } from './rateLimiter';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const CrossrefSearchInputSchema = z.strictObject({
  query: z.string(),
  rows: z.int().positive().max(CROSSREF_CONSTANTS.MAX_ROWS).optional(),
  offset: z.int().min(0).optional(),
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

/**
 * Extended QueryWorksParams to include filter field.
 * Note: The Crossref API supports filter parameters, but the library type definitions
 * (@jamesgopsill/crossref-client) are incomplete and don't include this field.
 * See: https://api.crossref.org/swagger-ui/index.html#/Works/get_works
 */
type ExtendedQueryWorksParams = QueryWorksParams & { filter?: string };

/**
 * Type guard to safely access Crossref work item properties.
 * The library returns untyped objects, so we use this helper to access properties safely.
 */
function isWorkItem(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null;
}

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
      rows: input.rows ?? CROSSREF_CONSTANTS.DEFAULT_ROWS,
    };
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
      // Respect Crossref API rate limits
      await waitForRateLimit(
        'crossref',
        CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
      );
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
      if (!isWorkItem(item)) {
        return {
          title: null,
          doi: null,
          publisher: null,
          type: null,
          issued: null,
          url: null,
        };
      }
      const titleValue = item.title;
      const primaryTitle = Array.isArray(titleValue)
        ? (titleValue.find((entry) => typeof entry === 'string') ?? null)
        : typeof titleValue === 'string'
          ? titleValue
          : null;

      return {
        title: primaryTitle,
        doi: typeof item.DOI === 'string' ? item.DOI : null,
        publisher: typeof item.publisher === 'string' ? item.publisher : null,
        type: typeof item.type === 'string' ? item.type : null,
        issued: item.issued ?? null,
        url: typeof item.URL === 'string' ? item.URL : null,
      };
    });

    const payload = {
      query: trimmedQuery,
      count: results.length,
      totalResults:
        typeof message.totalResults === 'number' ? message.totalResults : null,
      results,
    };

    return toolResult({
      summary: `Found ${results.length} Crossref result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
