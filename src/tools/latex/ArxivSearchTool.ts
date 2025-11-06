// Third-party imports
import { z } from 'zod';

// Local imports - arxiv wrapper
import { search } from './arxivApiWrapper';

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

    const includeTags = [
      {
        name: trimmedQuery,
      },
      ...(input.categories?.map((category) => ({
        name: category.trim(),
        prefix: 'cat' as const,
      })) ?? []),
    ].filter((tag) => tag.name.length > 0);

    if (includeTags.length === 0) {
      throw new ToolError('Search query cannot be empty.');
    }

    let response;
    try {
      response = await search({
        searchQueryParams: [
          {
            include: includeTags,
          },
        ],
        start: input.start,
        maxResults: input.maxResults ?? 10,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to query arXiv API: ${message}`);
    }

    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const results = entries.map((entry) => {
      const identifier = extractEntryIdentifier(entry.id);
      return {
        id: identifier ?? null,
        doi: entry.doi ?? null,
        title:
          typeof entry.title === 'string' ? entry.title.trim() : entry.title,
        summary: entry.summary ?? null,
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
      start: response?.startIndex ?? input.start ?? 0,
      count: results.length,
      totalResults: response?.totalResults ?? null,
      results,
    };

    return toolResult({
      summary: `Found ${results.length} arXiv result${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`,
      output: JSON.stringify(payload, null, 2),
    });
  }
}
