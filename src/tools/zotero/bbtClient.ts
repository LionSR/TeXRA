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
import {
  ZOTERO_BBT_TIMEOUT_MS,
  buildTimeoutMessage,
} from '@tools/timeouts';
import { getConfig } from '@utils/config';

/**
 * Get the configured Zotero port.
 * Used by both Connector API and Better BibTeX JSON-RPC (same port, different paths).
 */
export function getZoteroPort(): number {
  return getConfig<number>('texra.bib.zoteroPort', 23119);
}

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
 * CSL JSON name/creator format.
 * See: https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 *
 * From BBT source: Zotero.Utilities.Item.itemToCSLJSON(item)
 */
export interface CslCreator {
  /** Family name (surname) in CSL format */
  family?: string;
  /** Given name (first name) in CSL format */
  given?: string;
  /** Institutional or single-field name */
  literal?: string;
  // Zotero native format (may appear in some responses)
  lastName?: string;
  firstName?: string;
  name?: string;
  creatorType?: string;
}

/**
 * CSL JSON date format.
 */
export interface CslDate {
  /** Date parts as [[year, month?, day?]] */
  'date-parts'?: number[][];
  /** Raw date string */
  raw?: string;
  /** Literal date text */
  literal?: string;
}

/**
 * CSL JSON item returned by Better BibTeX item.search.
 *
 * This is standard CSL JSON (from Zotero.Utilities.Item.itemToCSLJSON)
 * plus BBT-specific `library` and `citekey` fields.
 *
 * Reference: https://github.com/retorquere/zotero-better-bibtex/blob/master/content/json-rpc.ts
 */
export interface BbtSearchResultItem {
  // ─── Better BibTeX additions ───────────────────────────────────────
  /** Citation key from Better BibTeX KeyManager */
  citekey: string;
  /** Library name or fallback `library#${libraryID}` */
  library: string;

  // ─── CSL JSON core fields ──────────────────────────────────────────
  /** Internal Zotero item ID (as URI or number) */
  id?: string | number;
  /** CSL item type (article-journal, book, chapter, etc.) */
  type?: string;
  /** Item title */
  title?: string;
  /** Authors */
  author?: CslCreator[];
  /** Editors */
  editor?: CslCreator[];
  /** Publication/issue date */
  issued?: CslDate;
  /** Access date */
  accessed?: CslDate;

  // ─── Zotero-style fields (legacy, may appear) ──────────────────────
  itemType?: string;
  creators?: CslCreator[];
  date?: string;

  // ─── Identifiers ───────────────────────────────────────────────────
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  URL?: string;

  // ─── Publication info ──────────────────────────────────────────────
  /** Journal/book title */
  'container-title'?: string;
  /** Short container title */
  'container-title-short'?: string;
  /** Publisher name */
  publisher?: string;
  /** Publisher location */
  'publisher-place'?: string;
  /** Volume number */
  volume?: string;
  /** Issue number */
  issue?: string;
  /** Page range */
  page?: string;
  /** Number of pages */
  'number-of-pages'?: string;
  /** Edition */
  edition?: string;

  // ─── Content ───────────────────────────────────────────────────────
  abstract?: string;
  note?: string;
  language?: string;
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
  timeout: number = ZOTERO_BBT_TIMEOUT_MS,
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
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new ToolError(
        buildTimeoutMessage('Zotero API request', timeout),
      );
    }
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
