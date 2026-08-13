/**
 * Search Zotero library via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { z } from 'zod';

// Local imports - core
import type { ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - zotero
import {
  callBetterBibTeX,
  getZoteroPort,
  BbtCollectionChainSchema,
  BbtSearchResultItemSchema,
  type BbtCollectionChain,
  type BbtSearchResultItem,
} from './bbtClient';

const QUERY_DESCRIPTION =
  'Quick search string (searches across title, creators, and year simultaneously). ' +
  'Best for short queries like a single surname or citekey. ' +
  'All words must match, so keep it to one or two terms. ' +
  'Omit this when using the structured title/author/year fields instead.';

const TITLE_DESCRIPTION =
  'Search by title (partial match). Use a few distinctive words, not the full title.';

const AUTHOR_DESCRIPTION =
  'Search by author/creator surname (partial match). Use a single surname.';

const YEAR_DESCRIPTION = 'Filter by publication year (exact match).';

const ZoteroSearchInputSchema = z
  .strictObject({
    query: z.string().min(1).describe(QUERY_DESCRIPTION).nullish(),
    title: z.string().describe(TITLE_DESCRIPTION).nullish(),
    author: z.string().describe(AUTHOR_DESCRIPTION).nullish(),
    year: z
      .union([z.string(), z.number()])
      .describe(YEAR_DESCRIPTION)
      .nullish(),
    library: z
      .string()
      .describe(
        'Optional library name to search in. Use "*" to search all libraries.',
      )
      .nullish(),
    include_collections: z
      .boolean()
      .describe(
        'When true, each result includes the Zotero collections (folders) it belongs to, ' +
          'shown as breadcrumb paths. Useful for understanding how the library is organized.',
      )
      .nullish(),
  })
  .refine(
    (data) => data.query || data.title || data.author || data.year,
    'At least one of query, title, author, or year must be provided.',
  );

type ZoteroSearchInput = z.infer<typeof ZoteroSearchInputSchema>;

/**
 * Build a human-readable label from whichever search parameters are set.
 */
function describeSearch(
  input: Pick<ZoteroSearchInput, 'query' | 'title' | 'author' | 'year'>,
): string {
  const parts: string[] = [];
  if (input.title) parts.push(`title="${input.title}"`);
  if (input.author) parts.push(`author="${input.author}"`);
  if (input.year) parts.push(`year=${input.year}`);
  return parts.length > 0 ? parts.join(', ') : (input.query ?? 'query');
}

/**
 * Format a single search result item for display.
 */
function formatSearchResult(item: BbtSearchResultItem): string {
  const citekey = item.citekey || 'unknown';
  const title = item.title || 'Untitled';

  // Handle both CSL JSON (author) and Zotero (creators) formats
  const creatorList = item.author || item.creators || [];
  const creators = creatorList
    .map((c) => {
      if (c.family) {
        return c.given ? `${c.family}, ${c.given}` : c.family;
      }
      if (c.lastName) {
        return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName;
      }
      return c.name || '';
    })
    .filter(Boolean)
    .join('; ');

  // Handle date from CSL JSON or Zotero format
  const datePart = item.issued?.['date-parts']?.[0]?.[0];
  const year = datePart ? String(datePart) : (item.date ?? '');

  const type = item.type || item.itemType || 'item';

  // Build formatted string with optional parts
  const creatorPart = creators ? ` - ${creators}` : '';
  const yearPart = year ? ` (${year})` : '';
  return `[${citekey}] ${title}${creatorPart}${yearPart} [${type}]`;
}

/**
 * Flatten a nested parent chain into a breadcrumb path.
 */
function collectionPath(chain: BbtCollectionChain): string {
  const parts: string[] = [];
  let current: BbtCollectionChain | false | undefined = chain;
  while (current) {
    parts.unshift(current.name);
    current = current.parentCollection;
  }
  return parts.join(' / ');
}

export class ZoteroSearchTool extends defineTool({
  name: 'zotero_search',
  parallelSafe: true,
  description:
    'Search Zotero library by citation key, title, author, or year. ' +
    'Prefer the structured title/author/year fields over a single query string. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroSearchInputSchema,
}) {
  protected async execute({
    query,
    title,
    author,
    year,
    library,
    include_collections,
  }: ZoteroSearchInput): Promise<ToolResult> {
    const port = getZoteroPort();

    // Build search params: use advanced tuple search when structured fields
    // are provided, otherwise fall back to simple quick-search string.
    const searchTerms: unknown =
      title || author || year
        ? [
            ...(title ? [['title', 'contains', title]] : []),
            ...(author ? [['creator', 'contains', author]] : []),
            ...(year ? [['date', 'is', String(year)]] : []),
          ]
        : query!;

    const params: unknown[] = library ? [searchTerms, library] : [searchTerms];

    const result = await callBetterBibTeX(
      'item.search',
      params,
      port,
      z.array(BbtSearchResultItemSchema),
    );

    const label = describeSearch({ query, title, author, year });

    if (result.length === 0) {
      return executed(
        'No matching items in Zotero library.',
        `No results found for ${label}`,
      );
    }

    const collectionMap = include_collections
      ? await callBetterBibTeX(
          'item.collections',
          [result.map((r) => r.citekey), true],
          port,
          z.record(z.string(), z.array(BbtCollectionChainSchema)),
        )
      : null;

    // Format results
    const items = result.map((item) => {
      const base = formatSearchResult(item);
      if (!collectionMap) return base;

      const chains = collectionMap[item.citekey];
      if (!chains || chains.length === 0) return base;

      const paths = chains.map((c) => collectionPath(c));
      return `${base}\n  Filed in: ${paths.join(', ')}`;
    });

    return executed(
      items.join('\n'),
      `Found ${formatResultCount(result.length, 'item')} matching ${label}`,
    );
  }
}
