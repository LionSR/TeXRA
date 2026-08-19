// Third-party imports
import {
  SortOrder,
  type QueryWorksParams,
  type Work,
  type WorkSortOptions,
} from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas';
import { requireNonEmptyString } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { CROSSREF_CONSTANTS, CrossrefClient } from './constants';
import { rateLimitedApiCall } from './rateLimiter';

const CROSSREF_SEARCH_FIELDS = {
  query: z.string().describe('Bibliographic search query for Crossref works.'),
  rows: nullishWithDefault(
    z.int().positive().max(CROSSREF_CONSTANTS.MAX_ROWS),
    CROSSREF_CONSTANTS.DEFAULT_ROWS,
  ).describe('Maximum number of works to return.'),
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
};
const CROSSREF_DOI_DESCRIPTION =
  'DOI to look up, with or without a DOI URL prefix.';
const CROSSREF_DOI_FIELD = z.string().describe(CROSSREF_DOI_DESCRIPTION);

// Provider conversion flattens top-level unions into one object. Keep both
// declared field sets in each strict branch so provider-valid inactive fields
// are accepted and ignored while unknown fields remain rejected.
const CrossrefSearchInputSchema = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('search').describe('Search Crossref works.'),
    ...CROSSREF_SEARCH_FIELDS,
    doi: CROSSREF_DOI_FIELD.nullish().describe(CROSSREF_DOI_DESCRIPTION),
  }),
  z.strictObject({
    command: z.literal('doi').describe('Look up one DOI in Crossref.'),
    query: CROSSREF_SEARCH_FIELDS.query.nullish(),
    rows: CROSSREF_SEARCH_FIELDS.rows,
    offset: CROSSREF_SEARCH_FIELDS.offset,
    sort: CROSSREF_SEARCH_FIELDS.sort,
    order: CROSSREF_SEARCH_FIELDS.order,
    filter: CROSSREF_SEARCH_FIELDS.filter,
    doi: CROSSREF_DOI_FIELD,
  }),
]);

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
  description:
    'Search Crossref works or look up detailed metadata for a DOI. Use command="search" with query, or command="doi" with doi.',
  schema: CrossrefSearchInputSchema,
}) {
  protected async execute(input: CrossrefSearchInput): Promise<ToolResult> {
    if (input.command === 'doi') {
      const trimmedDoi = requireNonEmptyString(input.doi, 'DOI');

      const response = await rateLimitedApiCall(
        'crossref',
        CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
        'Crossref DOI lookup',
        'Crossref lookup failed',
        () => CrossrefClient.work(trimmedDoi),
      );

      if (!response.ok || !response.content?.message) {
        throw new ToolError('Crossref response did not include metadata.');
      }

      const work: Work = response.content.message;
      const metadata = {
        doi: work.DOI,
        title: work.title?.[0] ?? null,
        titles: work.title ?? [],
        publisher: work.publisher,
        type: work.type,
        abstract: work.abstract ?? null,
        description: null, // Not exposed by the library type.
        created: work.created,
        published: work.published ?? null,
        url: work.resource?.primary?.URL ?? null,
        language: work.language ?? null,
        authors: work.author ?? [],
        licenses: work.license ?? [],
      };

      return executed(
        JSON.stringify(metadata, null, 2),
        `Retrieved: DOI ${metadata.doi}`,
      );
    }

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

    const response = await rateLimitedApiCall(
      'crossref',
      CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
      'Crossref search',
      'Crossref search failed',
      () => CrossrefClient.works(options),
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

    return executed(
      JSON.stringify(payload, null, 2),
      `Found: ${results.length} ${pluralize(results.length, 'result')} for "${trimmedQuery}"`,
    );
  }
}
