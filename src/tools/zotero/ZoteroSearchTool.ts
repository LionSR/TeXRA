/**
 * Search Zotero library via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import axios from 'axios';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { getConfig } from '@utils/config';

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

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Call Better BibTeX JSON-RPC endpoint.
 */
async function callBetterBibTeX(
  method: string,
  params: unknown[],
  port: number,
): Promise<unknown> {
  const url = `http://127.0.0.1:${port}/better-bibtex/json-rpc`;

  try {
    const response = await axios.post<JsonRpcResponse>(
      url,
      {
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      },
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    return response.data.result;
  } catch (error) {
    if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
      throw new ToolError(
        'Please start Zotero desktop app. The Connector API is not responding.',
      );
    }
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new ToolError(
        'Better BibTeX plugin is not installed. ' +
          'Install it from https://retorque.re/zotero-better-bibtex/',
      );
    }
    throw new ToolError(`Better BibTeX API error: ${toErrorMessage(error)}`);
  }
}

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

    const result = await callBetterBibTeX('item.search', params, port);

    if (!Array.isArray(result) || result.length === 0) {
      return {
        summary: `No results found for "${query}"`,
        output: 'No matching items in Zotero library.',
      };
    }

    // Format results
    const items = result.map((item: Record<string, unknown>) => {
      const citekey = item.citekey || item.citationKey || 'unknown';
      const title = item.title || 'Untitled';
      const creators = Array.isArray(item.creators)
        ? item.creators
            .map((c: Record<string, string>) =>
              c.lastName ? `${c.lastName}, ${c.firstName || ''}`.trim() : c.name,
            )
            .join('; ')
        : '';
      const year = item.date || item.year || '';
      const type = item.itemType || 'item';

      return `[${citekey}] ${title}${creators ? ` - ${creators}` : ''}${year ? ` (${year})` : ''} [${type}]`;
    });

    return {
      summary: `Found ${result.length} item${result.length === 1 ? '' : 's'} matching "${query}"`,
      output: items.join('\n'),
    };
  }
}
