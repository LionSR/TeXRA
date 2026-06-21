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
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import { isTimeoutErrorCode } from '@tools/timeouts';
import { getConfig } from '@utils/config/configUtils';

const ZOTERO_BBT_TIMEOUT_MS = 10_000; // 10 s

/**
 * Get the configured Zotero port.
 * Used by both Connector API and Better BibTeX JSON-RPC (same port, different paths).
 */
export function getZoteroPort(): number {
  return getConfig<number>('texra.bib.zoteroPort', 23119);
}

// ============================================================================
// Response schemas — Better BibTeX is an external network boundary, so its
// JSON-RPC envelope and result shapes are the single source of truth here (the
// types are derived via z.infer) and validated once in callBetterBibTeX. The
// result schemas assert only the fields consumers read; z.object strips any
// extra fields the API adds (it tolerates them rather than rejecting), and the
// inferred types match the original interfaces exactly.
// ============================================================================

/** JSON-RPC error object. */
const JsonRpcErrorSchema = z.object({ code: z.number(), message: z.string() });

/** JSON-RPC response envelope around a method's typed result. */
function jsonRpcResponseSchema<T>(result: z.ZodType<T>) {
  return z.object({
    jsonrpc: z.string(),
    id: z.number().optional(),
    result: result.optional(),
    error: JsonRpcErrorSchema.optional(),
  });
}

/**
 * CSL JSON name/creator format.
 * See: https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 *
 * From BBT source: Zotero.Utilities.Item.itemToCSLJSON(item)
 */
const CslCreatorSchema = z.object({
  /** Family name (surname) in CSL format */
  family: z.string().optional(),
  /** Given name (first name) in CSL format */
  given: z.string().optional(),
  /** Institutional or single-field name */
  literal: z.string().optional(),
  // Zotero native format (may appear in some responses)
  lastName: z.string().optional(),
  firstName: z.string().optional(),
  name: z.string().optional(),
  creatorType: z.string().optional(),
});
export type CslCreator = z.infer<typeof CslCreatorSchema>;

/** CSL JSON date format. */
const CslDateSchema = z.object({
  /** Date parts as [[year, month?, day?]] */
  'date-parts': z.array(z.array(z.number())).optional(),
  /** Raw date string */
  raw: z.string().optional(),
  /** Literal date text */
  literal: z.string().optional(),
});
export type CslDate = z.infer<typeof CslDateSchema>;

/** Zotero collection metadata returned by `user.groups(true)`. */
export const BbtCollectionSchema = z.object({
  key: z.string(),
  name: z.string(),
  parentCollection: z.union([z.string(), z.literal(false)]).optional(),
});
export type BbtCollection = z.infer<typeof BbtCollectionSchema>;

/** Library (group) entry returned by `user.groups`. */
export const BbtLibrarySchema = z.object({
  id: z.number(),
  name: z.string(),
  collections: z.array(BbtCollectionSchema).optional(),
});
export type BbtLibrary = z.infer<typeof BbtLibrarySchema>;

/**
 * Collection with nested parent chain, returned by `item.collections(citekeys, true)`.
 * When `includeParents` is true, `parentCollection` is recursively expanded
 * into a full object instead of a key string.
 *
 * The type is self-referential, so the interface is kept and the recursive
 * schema is annotated against it (z.lazy).
 */
export interface BbtCollectionChain {
  key: string;
  name: string;
  parentCollection?: BbtCollectionChain | false;
}
export const BbtCollectionChainSchema: z.ZodType<BbtCollectionChain> = z.lazy(
  () =>
    z.object({
      key: z.string(),
      name: z.string(),
      parentCollection: z
        .union([BbtCollectionChainSchema, z.literal(false)])
        .optional(),
    }),
);

/**
 * CSL JSON item returned by Better BibTeX item.search.
 *
 * This is standard CSL JSON (from Zotero.Utilities.Item.itemToCSLJSON) plus
 * BBT-specific `library` and `citekey` fields. Reference:
 * https://github.com/retorquere/zotero-better-bibtex/blob/master/content/json-rpc.ts
 */
export const BbtSearchResultItemSchema = z.object({
  // ─── Better BibTeX additions ───────────────────────────────────────
  /** Citation key from Better BibTeX KeyManager */
  citekey: z.string(),
  /** Library name or fallback `library#${libraryID}` */
  library: z.string(),

  // ─── CSL JSON core fields ──────────────────────────────────────────
  /** Internal Zotero item ID (as URI or number) */
  id: z.union([z.string(), z.number()]).optional(),
  /** CSL item type (article-journal, book, chapter, etc.) */
  type: z.string().optional(),
  /** Item title */
  title: z.string().optional(),
  /** Authors */
  author: z.array(CslCreatorSchema).optional(),
  /** Editors */
  editor: z.array(CslCreatorSchema).optional(),
  /** Publication/issue date */
  issued: CslDateSchema.optional(),
  /** Access date */
  accessed: CslDateSchema.optional(),

  // ─── Zotero-style fields (legacy, may appear) ──────────────────────
  itemType: z.string().optional(),
  creators: z.array(CslCreatorSchema).optional(),
  date: z.string().optional(),

  // ─── Identifiers ───────────────────────────────────────────────────
  DOI: z.string().optional(),
  ISBN: z.string().optional(),
  ISSN: z.string().optional(),
  PMID: z.string().optional(),
  PMCID: z.string().optional(),
  URL: z.string().optional(),

  // ─── Publication info ──────────────────────────────────────────────
  /** Journal/book title */
  'container-title': z.string().optional(),
  /** Short container title */
  'container-title-short': z.string().optional(),
  /** Publisher name */
  publisher: z.string().optional(),
  /** Publisher location */
  'publisher-place': z.string().optional(),
  /** Volume number */
  volume: z.string().optional(),
  /** Issue number */
  issue: z.string().optional(),
  /** Page range */
  page: z.string().optional(),
  /** Number of pages */
  'number-of-pages': z.string().optional(),
  /** Edition */
  edition: z.string().optional(),

  // ─── Content ───────────────────────────────────────────────────────
  abstract: z.string().optional(),
  note: z.string().optional(),
  language: z.string().optional(),
});
export type BbtSearchResultItem = z.infer<typeof BbtSearchResultItemSchema>;

/**
 * Call Better BibTeX JSON-RPC endpoint.
 *
 * @param method - JSON-RPC method name (e.g., 'item.search', 'item.export')
 * @param params - Method parameters
 * @param port - Zotero Connector port (default: 23119)
 * @param resultSchema - Zod schema for the method's `result`, validated at the boundary
 * @param timeout - Request timeout in milliseconds
 * @returns Promise resolving to the validated result
 * @throws ToolError if Zotero is not running, BBT is not installed, or the response is malformed
 */
export async function callBetterBibTeX<T>(
  method: string,
  params: unknown[],
  port: number,
  resultSchema: z.ZodType<T>,
  timeout: number = ZOTERO_BBT_TIMEOUT_MS,
): Promise<T> {
  const url = `http://127.0.0.1:${port}/better-bibtex/json-rpc`;

  const response = await axios
    .post<unknown>(
      url,
      { jsonrpc: '2.0', method, params, id: 1 },
      { timeout, headers: { 'Content-Type': 'application/json' } },
    )
    .catch((error: unknown) => {
      if (axios.isAxiosError(error)) {
        if (isTimeoutErrorCode(error.code)) {
          throw new ToolError(
            `Zotero API request timed out after ${timeout / 1000}s. ` +
              `Retry the request. If it persists, ask the user to check that Zotero is responsive.`,
          );
        }
        if (error.code === 'ECONNREFUSED') {
          throw new ToolError(
            `Zotero is not reachable on port ${port}. ` +
              `Ask the user to start Zotero or verify the port (setting: texra.bib.zoteroPort).`,
          );
        }
        if (error.response?.status === StatusCodes.NOT_FOUND) {
          throw new ToolError(
            'Better BibTeX plugin is not installed in Zotero. ' +
              'Ask the user to install it from https://retorque.re/zotero-better-bibtex/',
          );
        }
      }
      throw new ToolError(`Better BibTeX API error: ${toErrorMessage(error)}`);
    });

  const parsed = jsonRpcResponseSchema(resultSchema).safeParse(response.data);
  if (!parsed.success) {
    throw new ToolError(
      `Better BibTeX returned an unexpected response for ${method}: ${parsed.error.message}`,
    );
  }
  if (parsed.data.error) {
    throw new ToolError(
      `Better BibTeX API error: ${parsed.data.error.message}`,
    );
  }
  if (parsed.data.result === undefined) {
    throw new ToolError(
      `Better BibTeX returned an empty response for ${method}.`,
    );
  }
  return parsed.data.result;
}
