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

// Local imports - latex
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import {
  type ArxivSearchResult,
  createArxivClient,
  extractEntryIdentifier,
  getAuthorNames,
  normaliseArxivIdentifier,
} from '@tools/latex/arxivShared';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { waitForRateLimit } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';

const SortBySchema = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const SortOrderSchema = z.enum(['ascending', 'descending']);
const SearchFieldSchema = z.enum(['all', 'author', 'title', 'abstract']);

const ArxivSearchInputSchema = z.strictObject({
  query: z.string(),
  field: SearchFieldSchema.nullish().describe(
    'Search field: "author" for author names, "title" for paper titles, "abstract" for abstracts, "all" (default) for all fields',
  ),
  categories: z.array(z.string()).nullish(),
  maxResults: z.int().positive().max(ARXIV_CONSTANTS.MAX_RESULTS).nullish(),
  start: z.int().min(0).nullish(),
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
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      throw new ToolError('Search query cannot be empty.');
    }

    // Select the query function based on the field parameter
    const searchField = input.field ?? 'all';
    const fieldQueryFn = (term: string) => {
      switch (searchField) {
        case 'author':
          return authorQuery(term);
        case 'title':
          return titleQuery(term);
        case 'abstract':
          return abstractQuery(term);
        default:
          return all(term);
      }
    };

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
            // catQuery expects a strict Category union type (e.g., "cs.AI", "math.CO")
            // We accept user input as string and handle invalid categories gracefully
            categoryFilters.push(catQuery(trimmed as never));
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
      .start(input.start ?? 0)
      .maxResults(input.maxResults ?? ARXIV_CONSTANTS.DEFAULT_RESULTS);

    if (input.sortBy) {
      client = client.sortBy(input.sortBy);
    }

    if (input.sortOrder) {
      client = client.sortOrder(input.sortOrder);
    }

    let entries;
    try {
      // Respect arXiv API rate limits
      await waitForRateLimit('arxiv', ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS);
      entries = await client.execute();
    } catch (error) {
      throw new ToolError(
        `Failed to query arXiv API: ${toErrorMessage(error)}`,
      );
    }

    const results: ArxivSearchResult[] = entries.map((entry) => {
      const identifier = extractEntryIdentifier(entry.id);
      return {
        id: identifier ?? null,
        doi: entry.doi?.id ?? null,
        title:
          typeof entry.title === 'string' ? entry.title.trim() : entry.title,
        abstract: entry.summary ?? null,
        published: entry.published ?? null,
        updated: entry.updated ?? null,
        authors: getAuthorNames(entry.authors),
        primaryCategory: entry.primaryCategory ?? null,
        arxivUrl: identifier
          ? `https://arxiv.org/abs/${normaliseArxivIdentifier(identifier)}`
          : null,
      };
    });

    const payload = {
      query: trimmedQuery,
      field: searchField,
      start: input.start ?? 0,
      count: results.length,
      totalResults: null, // arxiv-client doesn't expose totalResults
      results,
    };

    const fieldLabel = searchField !== 'all' ? ` (${searchField})` : '';
    return {
      summary: `Found ${results.length} arXiv result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"${fieldLabel}`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
