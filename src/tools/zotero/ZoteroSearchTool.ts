/**
 * Search Zotero library via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { z } from 'zod';

// Local imports - core
import { defineTool } from '@tools/core/define';

// Local imports - zotero
import {
  callBetterBibTeX,
  getZoteroPort,
  type BbtSearchResultItem,
} from './bbtClient';

const ZoteroSearchInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query - can be citation key, title, author, or year. ' +
        'Works like the search box in Zotero.',
    ),
  library: z
    .string()
    .describe(
      'Optional library name to search in. Use "*" to search all libraries.',
    )
    .nullish(),
});

export type ZoteroSearchInput = z.infer<typeof ZoteroSearchInputSchema>;

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
  let year = '';
  if (item.issued?.['date-parts']?.[0]?.[0]) {
    year = String(item.issued['date-parts'][0][0]);
  } else if (item.date) {
    year = item.date;
  }

  const type = item.type || item.itemType || 'item';

  // Build formatted string with optional parts
  const creatorPart = creators ? ` - ${creators}` : '';
  const yearPart = year ? ` (${year})` : '';
  return `[${citekey}] ${title}${creatorPart}${yearPart} [${type}]`;
}

export class ZoteroSearchTool extends defineTool({
  name: 'zotero_search',
  description:
    'Search Zotero library by citation key, title, author, or year. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroSearchInputSchema,
}) {
  protected async execute({ query, library }: ZoteroSearchInput) {
    const port = getZoteroPort();

    const params: unknown[] = [query];
    if (library) {
      params.push(library);
    }

    const result = await callBetterBibTeX<BbtSearchResultItem[]>(
      'item.search',
      params,
      port,
    );

    if (!Array.isArray(result) || result.length === 0) {
      return {
        summary: `No results found for "${query}"`,
        output: 'No matching items in Zotero library.',
      };
    }

    // Format results
    const items = result.map((item) => formatSearchResult(item));

    return {
      summary: `Found ${result.length} item${result.length === 1 ? '' : 's'} matching "${query}"`,
      output: items.join('\n'),
    };
  }
}
