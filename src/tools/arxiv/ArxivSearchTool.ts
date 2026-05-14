// Third-party imports
import {
  all,
  and,
  author as authorQuery,
  title as titleQuery,
  abstract as abstractQuery,
  category as catQuery,
} from 'arxiv-client';
type Category = Parameters<typeof catQuery>[0];
import { z } from 'zod';

// Local imports
import { pluralize } from '@tools/formatting';
import { requireNonEmptyString, wrapApiCall } from '@tools/utils';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { waitForRateLimit } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';
import {
  type ArxivSearchResult,
  createArxivClient,
  extractBasePaperMetadata,
  normaliseArxivIdentifier,
} from '@tools/latex/arxivShared';

const SortBySchema = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const SortOrderSchema = z.enum(['ascending', 'descending']);
const SearchFieldSchema = z.enum(['all', 'author', 'title', 'abstract']);

const ArxivSearchInputSchema = z.strictObject({
  query: z.string(),
  field: SearchFieldSchema.nullish()
    .transform((v) => v ?? 'all')
    .describe(
      'Search field: "author" for author names, "title" for paper titles, "abstract" for abstracts, "all" (default) for all fields',
    ),
  categories: z.array(z.string()).nullish(),
  maxResults: z
    .int()
    .positive()
    .max(ARXIV_CONSTANTS.MAX_RESULTS)
    .nullish()
    .transform((v) => v ?? ARXIV_CONSTANTS.DEFAULT_RESULTS),
  start: z
    .int()
    .min(0)
    .nullish()
    .transform((v) => v ?? 0),
  sortBy: SortBySchema.nullish(),
  sortOrder: SortOrderSchema.nullish(),
});

export type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

export class ArxivSearchTool extends defineTool({
  name: 'arxiv_search',
  description:
    'Search arXiv for papers and return basic metadata for each hit. Use field="author" for author name searches.',
  schema: ArxivSearchInputSchema,
}) {
  protected async execute(input: ArxivSearchInput) {
    const trimmedQuery = requireNonEmptyString(input.query, 'Search query');

    // Select the query function based on the field parameter
    const fieldQueryFns = {
      author: authorQuery,
      title: titleQuery,
      abstract: abstractQuery,
      all: all,
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
    if (input.categories && input.categories.length > 0) {
      const categoryFilters: ReturnType<typeof catQuery>[] = [];
      for (const cat of input.categories) {
        const trimmed = cat.trim();
        if (trimmed.length > 0) {
          try {
            // catQuery expects a strict Category union ("cs.AI", "math.CO", ...).
            // User input is unconstrained string — cast to the expected type
            // and rely on the library's runtime validation (caught below).
            categoryFilters.push(catQuery(trimmed as Category));
          } catch (error) {
            // Skip invalid categories silently - they won't be used in the query
            continue;
          }
        }
      }

      if (categoryFilters.length > 0) {
        query = and(query, ...categoryFilters);
      }
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

    const entries = await wrapApiCall(async () => {
      await waitForRateLimit('arxiv', ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS);
      return client.execute();
    }, 'Failed to query arXiv API');

    const results: ArxivSearchResult[] = entries.map((entry) => {
      const base = extractBasePaperMetadata(entry);
      return {
        ...base,
        abstract: entry.summary ?? null,
        arxivUrl: base.id
          ? `https://arxiv.org/abs/${normaliseArxivIdentifier(base.id)}`
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
    return {
      summary: `Found: ${results.length} ${pluralize(results.length, 'result')} for "${trimmedQuery}"${fieldLabel}`,
      output: JSON.stringify(payload, null, 2),
    };
  }
}
