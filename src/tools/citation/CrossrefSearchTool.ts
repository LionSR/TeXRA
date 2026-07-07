// Third-party imports
import {
  SortOrder,
  type QueryWorksParams,
  type WorkSortOptions,
} from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireNonEmptyString, wrapApiCall } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { CROSSREF_CONSTANTS, CrossrefClient } from './constants';
import { rateLimitedRequest } from './rateLimiter';

const CrossrefSearchInputSchema = z.strictObject({
  query: z.string().describe('Bibliographic search query for Crossref works.'),
  rows: z
    .int()
    .positive()
    .max(CROSSREF_CONSTANTS.MAX_ROWS)
    .nullish()
    .transform((v) => v ?? CROSSREF_CONSTANTS.DEFAULT_ROWS)
    .describe('Maximum number of works to return.'),
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe('Zero-based result offset for pagination.'),
  sort: z.string().nullish().describe('Crossref sort field to apply.'),
  order: z.enum(['asc', 'desc']).nullish().describe('Crossref sort order.'),
  // Filter as Crossref filter string format (e.g., "from-pub-date:2023,has-orcid:true")
  // Object format removed due to OpenAI JSON Schema limitations with z.record()
  filter: z
    .string()
    .nullish()
    .describe('Crossref filter string, e.g. "from-pub-date:2023".'),
});

export type CrossrefSearchInput = z.infer<typeof CrossrefSearchInputSchema>;

/**
 * Extended QueryWorksParams to include filter field.
 * Note: The Crossref API supports filter parameters, but the library type definitions
 * (@jamesgopsill/crossref-client) are incomplete and don't include this field.
 * See: https://api.crossref.org/swagger-ui/index.html#/Works/get_works
 */
type ExtendedQueryWorksParams = QueryWorksParams & { filter?: string };

export class CrossrefSearchTool extends defineTool({
  name: 'crossref_search',
  parallelSafe: true,
  description: 'Search Crossref works and return top matches.',
  schema: CrossrefSearchInputSchema,
}) {
  protected async execute(input: CrossrefSearchInput): Promise<ToolResult> {
    const trimmedQuery = requireNonEmptyString(input.query, 'Search query');

    const options: ExtendedQueryWorksParams = {
      query: trimmedQuery,
      rows: input.rows,
      ...(input.offset != null && { offset: input.offset }),
      ...(input.sort && { sort: input.sort as WorkSortOptions }),
      ...(input.order && {
        order: input.order === 'asc' ? SortOrder.ASC : SortOrder.DESC,
      }),
      ...(input.filter && { filter: input.filter }),
    };

    const response = await wrapApiCall(
      () =>
        rateLimitedRequest(
          'crossref',
          CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
          'Crossref search',
          () => CrossrefClient.works(options),
        ),
      'Crossref search failed',
    );

    if (!response.ok || !response.content?.message) {
      throw new ToolError('Crossref search did not return any items.');
    }

    const { message } = response.content;
    const results = message.items.map((work) => ({
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
      status: 'executed',
      summary: `Found: ${results.length} ${pluralize(results.length, 'result')} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    };
  }
}
