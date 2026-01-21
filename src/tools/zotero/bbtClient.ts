/**
 * Better BibTeX JSON-RPC client for Zotero integration.
 *
 * Provides typed access to the Better BibTeX JSON-RPC API at
 * http://localhost:23119/better-bibtex/json-rpc
 *
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import axios from 'axios';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';

/**
 * JSON-RPC response envelope.
 */
interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

/**
 * CSL JSON creator format returned by Better BibTeX.
 * See: https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 */
export interface CslCreator {
  family?: string;
  given?: string;
  // Legacy Zotero format
  lastName?: string;
  firstName?: string;
  name?: string;
  creatorType?: string;
}

/**
 * CSL JSON item format with Better BibTeX extensions.
 * Better BibTeX returns standard CSL JSON plus `library` and `citekey` fields.
 */
export interface BbtSearchResultItem {
  // Better BibTeX additions
  citekey: string;
  library: string;

  // Core CSL JSON fields
  id?: string | number;
  type?: string;
  title?: string;
  author?: CslCreator[];
  issued?: { 'date-parts'?: number[][] };

  // Zotero-style fields (also present in some responses)
  itemType?: string;
  creators?: CslCreator[];
  date?: string;

  // Additional common fields
  DOI?: string;
  URL?: string;
  abstract?: string;
  'container-title'?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
}

/**
 * Call Better BibTeX JSON-RPC endpoint.
 *
 * @param method - JSON-RPC method name (e.g., 'item.search', 'item.export')
 * @param params - Method parameters
 * @param port - Zotero Connector port (default: 23119)
 * @param timeout - Request timeout in milliseconds
 * @returns Promise resolving to the typed result
 * @throws ToolError if Zotero is not running or BBT is not installed
 */
export async function callBetterBibTeX<T = unknown>(
  method: string,
  params: unknown[],
  port: number,
  timeout: number = 10000,
): Promise<T> {
  const url = `http://127.0.0.1:${port}/better-bibtex/json-rpc`;

  try {
    const response = await axios.post<JsonRpcResponse<T>>(
      url,
      {
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      },
      {
        timeout,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    return response.data.result as T;
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
