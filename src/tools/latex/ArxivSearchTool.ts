// Third-party imports
import arxivClient, { all, and, category as catQuery } from 'arxiv-client';
import { z } from 'zod';

// Local imports - latex
import {
  extractEntryIdentifier,
  getAuthorNames,
  normaliseArxivIdentifier,
  readPrimaryCategory,
} from './arxivShared';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const SortBySchema = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const SortOrderSchema = z.enum(['ascending', 'descending']);

const ArxivSearchInputSchema = z.strictObject({
  query: z.string(),
  categories: z.array(z.string()).optional(),
  maxResults: z.number().int().positive().max(50).optional(),
  start: z.number().int().min(0).optional(),
  sortBy: SortBySchema.optional(),
  sortOrder: SortOrderSchema.optional(),
});

export type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

export class ArxivSearchTool extends defineTool({
  name: 'arxiv_search',
  description:
    'Search arXiv for papers and return basic metadata for each hit.',
  schema: ArxivSearchInputSchema,
}) {
  protected async execute(input: ArxivSearchInput) {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      throw new ToolError('Search query cannot be empty.');
    }

    // Build query using arxiv-client query builder
    let query = all(trimmedQuery);

    // Add category filters if provided
    if (input.categories && input.categories.length > 0) {
      const categoryFilters = input.categories
        .map((cat) => cat.trim())
        .filter((cat) => cat.length > 0)
        .map((cat) => catQuery(cat as any)); // User-provided categories may not match strict Category type

      if (categoryFilters.length > 0) {
        query = and(query, ...categoryFilters);
      }
    }

    let client = arxivClient
      .query(query)
      .start(input.start ?? 0)
      .maxResults(input.maxResults ?? 10);

    if (input.sortBy) {
      client = client.sortBy(input.sortBy);
    }

    if (input.sortOrder) {
      client = client.sortOrder(input.sortOrder);
    }

    let entries;
    try {
      entries = await client.execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to query arXiv API: ${message}`);
    }

    const results = entries.map((entry) => {
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
        primaryCategory: readPrimaryCategory(entry.primaryCategory),
        arxivUrl: identifier
          ? `https://arxiv.org/abs/${normaliseArxivIdentifier(identifier)}`
          : null,
      };
    });

    const payload = {
      query: trimmedQuery,
      start: input.start ?? 0,
      count: results.length,
      totalResults: null, // arxiv-client doesn't expose totalResults
      results,
    };

    return toolResult({
      summary: `Found ${results.length} arXiv result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
