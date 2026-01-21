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
import { getConfig } from '@utils/config';

// Local imports - zotero
import { callBetterBibTeX, type BbtSearchResultItem } from './bbtClient';

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

export class ZoteroSearchTool extends defineTool({
  name: 'zotero_search',
  description:
    'Search Zotero library by citation key, title, author, or year. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroSearchInputSchema,
}) {
  protected async execute({ query, library }: ZoteroSearchInput) {
    const port = getConfig<number>('texra.bib.zoteroConnectorPort', 23119);

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
    const items = result.map((item) => {
      const citekey = item.citekey || 'unknown';
      const title = item.title || 'Untitled';

      // Handle both CSL JSON (author) and Zotero (creators) formats
      const creatorList = item.author || item.creators || [];
      const creators = creatorList
        .map((c) => {
          // CSL JSON format: family/given
          if (c.family) {
            return `${c.family}${c.given ? `, ${c.given}` : ''}`;
          }
          // Zotero format: lastName/firstName
          if (c.lastName) {
            return `${c.lastName}${c.firstName ? `, ${c.firstName}` : ''}`;
          }
          // Single name format
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

      return `[${citekey}] ${title}${creators ? ` - ${creators}` : ''}${year ? ` (${year})` : ''} [${type}]`;
    });

    return {
      summary: `Found ${result.length} item${result.length === 1 ? '' : 's'} matching "${query}"`,
      output: items.join('\n'),
    };
  }
}
