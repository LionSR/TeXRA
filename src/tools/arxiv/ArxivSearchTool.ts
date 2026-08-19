// Third-party imports
import {
  all,
  and,
  author as authorQuery,
  title as titleQuery,
  abstract as abstractQuery,
  category as catQuery,
} from 'arxiv-client';
import { z } from 'zod';

// Local imports
import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';
import { warn } from '@logger/logUtils';
import type { ToolResult } from '@shared/schemas';
import { requireNonEmptyString } from '@tools/utils';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { rateLimitedApiCall } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';
import {
  type ArxivSearchResult,
  createArxivClient,
  extractBasePaperMetadata,
} from '@tools/arxiv/arxivShared';
import { executed } from '@tools/core/result';
import { withDefault } from '@tools/core/schemaDefaults';
import { pluralize } from '@utils/text/stringUtils';

type Category = Parameters<typeof catQuery>[0];

const SortBySchema = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const SortOrderSchema = z.enum(['ascending', 'descending']);
const SearchFieldSchema = z.enum(['all', 'author', 'title', 'abstract']);

const ArxivSearchInputSchema = z.strictObject({
  query: z
    .string()
    .describe('Search query terms, title text, or author names.'),
  field: withDefault(SearchFieldSchema, 'all' as const).describe(
    'Search field: "author" for author names, "title" for paper titles, "abstract" for abstracts, "all" (default) for all fields',
  ),
  categories: z
    .array(z.string())
    .nullish()
    .describe('Optional arXiv category filters such as "math.NT" or "cs.AI".'),
  maxResults: withDefault(
    z.int().positive().max(ARXIV_CONSTANTS.MAX_RESULTS),
    ARXIV_CONSTANTS.DEFAULT_RESULTS,
  ).describe('Maximum number of papers to return.'),
  start: withDefault(z.int().min(0), 0).describe(
    'Zero-based result offset for pagination.',
  ),
  sortBy: SortBySchema.nullish().describe('arXiv sort field to use.'),
  sortOrder: SortOrderSchema.nullish().describe('Sort direction for results.'),
});

export type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

export class ArxivSearchTool extends defineTool({
  name: 'arxiv_search',
  parallelSafe: true,
  description:
    'Search arXiv for papers and return basic metadata for each hit. Use field="author" for author name searches.',
  schema: ArxivSearchInputSchema,
}) {
  protected async execute(input: ArxivSearchInput): Promise<ToolResult> {
    const trimmedQuery = requireNonEmptyString(input.query, 'Search query');

    // Select the query function based on the field parameter
    const fieldQueryFns = {
      author: authorQuery,
      title: titleQuery,
      abstract: abstractQuery,
      all,
    } as const;
    const fieldQueryFn = fieldQueryFns[input.field];

    // Build query using arxiv-client query builder
    const terms = Array.from(
      trimmedQuery.matchAll(/"([^"]+)"|\S+/g),
      (match) => match[1] ?? match[0],
    );

    const termQueries = terms.map((term) => fieldQueryFn(term));
    let query = termQueries.length === 1 ? termQueries[0] : and(...termQueries);

    // Add category filters if provided
    const categoryFilters: ReturnType<typeof catQuery>[] = [];
    for (const cat of input.categories ?? []) {
      const trimmed = cat.trim();
      if (!trimmed) continue;
      try {
        // catQuery expects a strict Category union ("cs.AI", "math.CO", ...).
        // User input is unconstrained string — cast to the expected type
        // and rely on the library's runtime validation (caught below).
        categoryFilters.push(catQuery(trimmed as Category));
      } catch (error) {
        // Skip invalid categories — log so a silently-dropped filter is
        // traceable rather than mysteriously absent from the query.
        warn(
          'arxiv.search',
          `Ignoring invalid arxiv category filter "${trimmed}"`,
          { data: error },
        );
      }
    }

    if (categoryFilters.length > 0) {
      query = and(query, ...categoryFilters);
    }

    let client = createArxivClient()
      .query(query)
      .start(input.start)
      .maxResults(input.maxResults);

    if (input.sortBy) {
      client = client.sortBy(input.sortBy);
    }

    if (input.sortOrder) {
      client = client.sortOrder(input.sortOrder);
    }

    const entries = await rateLimitedApiCall(
      'arxiv',
      ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS,
      'arXiv search',
      'Failed to query arXiv API',
      () => client.execute(),
    );

    const results: ArxivSearchResult[] = entries.map((entry) => {
      const base = extractBasePaperMetadata(entry);
      return {
        ...base,
        abstract: entry.summary ?? null,
        arxivUrl: base.id
          ? `https://arxiv.org/abs/${normaliseArxivIdentifier(base.id) ?? base.id}`
          : null,
      };
    });

    const payload = {
      query: trimmedQuery,
      field: input.field,
      start: input.start,
      count: results.length,
      totalResults: null, // arxiv-client doesn't expose totalResults
      results,
    };

    const fieldLabel = input.field !== 'all' ? ` (${input.field})` : '';
    return executed(
      JSON.stringify(payload, null, 2),
      `Found: ${results.length} ${pluralize(results.length, 'result')} for "${trimmedQuery}"${fieldLabel}`,
    );
  }
}
