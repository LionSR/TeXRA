/**
 * Export BibTeX entries from Zotero via Better BibTeX JSON-RPC API.
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
import { pluralize } from '@tools/utils';
import { getConfig } from '@utils/config';

const ZoteroExportInputSchema = z.strictObject({
  citekeys: z
    .array(z.string().min(1))
    .min(1, 'At least one citation key must be provided.')
    .max(50, 'Maximum 50 citation keys can be exported at once.')
    .describe('List of Better BibTeX citation keys to export.'),
  format: z
    .enum(['bibtex', 'biblatex', 'json'])
    .describe('Export format. Defaults to biblatex.')
    .nullish(),
  library: z
    .string()
    .describe(
      'Optional library ID. Omit to search in My Library, or use "*" for all.',
    )
    .nullish(),
});

export type ZoteroExportInput = z.infer<typeof ZoteroExportInputSchema>;

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
        timeout: 30000,
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

export class ZoteroExportTool extends defineTool({
  name: 'zotero_export',
  description:
    'Export BibTeX/BibLaTeX entries from Zotero by citation keys. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroExportInputSchema,
}) {
  protected async execute({ citekeys, format, library }: ZoteroExportInput) {
    const port = getConfig<number>('texra.bib.zoteroConnectorPort', 23119);
    const translator = format || 'biblatex';

    const params: unknown[] = [citekeys, translator];
    if (library) {
      params.push(library);
    }

    const result = await callBetterBibTeX('item.export', params, port);

    if (typeof result !== 'string' || result.trim() === '') {
      throw new ToolError(
        `No entries found for citation keys: ${citekeys.join(', ')}`,
      );
    }

    return {
      summary: `Exported ${citekeys.length} ${pluralize(citekeys.length, 'entry', 'entries')} as ${translator}`,
      output: result.trim(),
    };
  }
}
