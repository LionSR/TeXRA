// Third-party imports
import {
  CrossrefClient,
  SortOrder,
  type QueryWorksParams,
  type Work,
  type WorkSortOptions,
} from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - metadata
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local file imports
import { CROSSREF_CONSTANTS } from './constants';
import { waitForRateLimit } from './rateLimiter';

const CrossrefSearchInputSchema = z.strictObject({
  query: z.string(),
  rows: z.int().positive().max(CROSSREF_CONSTANTS.MAX_ROWS).nullish(),
  offset: z.int().min(0).nullish(),
  sort: z.string().nullish(),
  order: z.enum(['asc', 'desc']).nullish(),
  filter: z
    .union([
      z.string(),
      z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    ])
    .nullish(),
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
      throw new ToolError(`Crossref search failed: ${toErrorMessage(error)}`);
    }

    if (!response.ok || !response.content || !response.content.message) {
      throw new ToolError('Crossref search did not return any items.');
    }

    const message = response.content.message;
    const items: Work[] = message.items;

    const results = items.map((work) => ({
      title: work.title?.[0] ?? null,
      doi: work.DOI,
      publisher: work.publisher,
      type: work.type,
      issued: work.issued,
      url: work.resource?.primary?.URL ?? null,
    }));

    const payload = {
      query: trimmedQuery,
      count: results.length,
      totalResults:
        typeof message.totalResults === 'number' ? message.totalResults : null,
      results,
    };

    return {
      summary: `Found ${results.length} Crossref result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    };
  }
}
