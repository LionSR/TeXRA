/**
 * Client for the local Zotero server used by every Zotero tool.
 *
 * Two endpoints share one host and port: the Better BibTeX JSON-RPC API at
 * http://localhost:23119/better-bibtex/json-rpc (search, export, collections)
 * and the Zotero Connector API at http://localhost:23119/connector/* (adding
 * items). Both live here so the base URL and the "Zotero is not reachable"
 * guidance have one definition.
 *
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 * See: https://www.zotero.org/support/dev/client_coding/connector_http_server
 */

// Third-party imports
import ky, { HTTPError } from 'ky';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ToolError } from '@shared/schemas';
import { isTimeoutError, joinAbortSignal } from '@tools/timeouts';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

const ZOTERO_BBT_TIMEOUT_MS = 10_000; // 10 s
const ZOTERO_PING_TIMEOUT_MS = 2_000; // 2 s
const ZOTERO_CONNECTOR_TIMEOUT_MS = 30_000; // 30 s

/**
 * Get the configured Zotero port.
 * Used by both Connector API and Better BibTeX JSON-RPC (same port, different paths).
 */
export function getZoteroPort(): number {
  return getConfig<number>('texra.bib.zoteroPort', 23119);
}

function zoteroUrl(port: number, pathname: string): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function zoteroUnreachableError(port: number): ToolError {
  return new ToolError(
    `Zotero is not reachable on port ${port}. ` +
      `Ask the user to start Zotero or verify the port (setting: texra.bib.zoteroPort).`,
  );
}

// ============================================================================
// Response schemas — Better BibTeX is an external network boundary, so its
// JSON-RPC envelope and result shapes are the single source of truth here (the
// types are derived via z.infer) and validated once in callBetterBibTeX. The
// result schemas assert only the fields consumers read; z.object strips any
// extra fields the API adds (it tolerates them rather than rejecting). Optional
// fields use .nullish() (not .optional()) because the CSL-JSON BBT emits may send
// an explicit null as well as omit a field — .optional() alone would reject null.
// Consumers already guard every such field with truthiness / optional chaining.
// ============================================================================

/** JSON-RPC error object. */
const JsonRpcErrorSchema = z.object({ code: z.number(), message: z.string() });

/**
 * CSL JSON name/creator format.
 * See: https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 *
 * From BBT source: Zotero.Utilities.Item.itemToCSLJSON(item)
 */
const CslCreatorSchema = z.object({
  /** Family name (surname) in CSL format */
  family: z.string().nullish(),
  /** Given name (first name) in CSL format */
  given: z.string().nullish(),
  // Zotero native format (may appear in some responses)
  lastName: z.string().nullish(),
  firstName: z.string().nullish(),
  name: z.string().nullish(),
});

/** CSL JSON date format. */
const CslDateSchema = z.object({
  /** Date parts as [[year, month?, day?]] */
  'date-parts': z.array(z.array(z.number())).nullish(),
});

/** Zotero collection metadata returned by `user.groups(true)`. */
const BbtCollectionSchema = z.object({
  key: z.string(),
  name: z.string(),
  parentCollection: z.union([z.string(), z.literal(false)]).nullish(),
});
export type BbtCollection = z.infer<typeof BbtCollectionSchema>;

/** Library (group) entry returned by `user.groups`. */
export const BbtLibrarySchema = z.object({
  id: z.number(),
  name: z.string(),
  collections: z.array(BbtCollectionSchema).nullish(),
});

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
 * the BBT-specific `citekey` field, narrowed to the fields the search tool
 * reads per the boundary rule above. Reference:
 * https://github.com/retorquere/zotero-better-bibtex/blob/master/content/json-rpc.ts
 */
export const BbtSearchResultItemSchema = z.object({
  /** Citation key from Better BibTeX KeyManager */
  citekey: z.string(),
  /** CSL item type (article-journal, book, chapter, etc.) */
  type: z.string().nullish(),
  /** Item title */
  title: z.string().nullish(),
  /** Authors */
  author: z.array(CslCreatorSchema).nullish(),
  /** Publication/issue date */
  issued: CslDateSchema.nullish(),

  // Zotero-style fields (legacy, may appear)
  itemType: z.string().nullish(),
  creators: z.array(CslCreatorSchema).nullish(),
  date: z.string().nullish(),
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
  const url = zoteroUrl(port, '/better-bibtex/json-rpc');

  // Cancellation for the owning agent run — a cancelled parallel batch must
  // abort a hung Zotero request instead of waiting out its timeout.
  const cancelSignal = getCurrentToolCallContext()?.signal;
  let raw: unknown;
  try {
    raw = await ky
      .post(url, {
        json: { jsonrpc: '2.0', method, params, id: 1 },
        timeout: false,
        signal: joinAbortSignal(timeout, cancelSignal),
        retry: 0,
      })
      .json<unknown>();
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      throw new ToolError(
        `Zotero API request timed out after ${timeout / 1000}s. ` +
          `Retry the request. If it persists, ask the user to check that Zotero is responsive.`,
      );
    }
    if (
      error instanceof HTTPError &&
      error.response.status === StatusCodes.NOT_FOUND
    ) {
      throw new ToolError(
        'Better BibTeX plugin is not installed in Zotero. ' +
          'Ask the user to install it from https://retorque.re/zotero-better-bibtex/',
      );
    }
    // TypeError from fetch (ECONNREFUSED → TypeError in native fetch): for a
    // localhost endpoint this is always a connection failure. This try block
    // wraps only the ky.post call, so no programmer TypeError can reach here.
    if (error instanceof TypeError) {
      throw zoteroUnreachableError(port);
    }
    throw new ToolError(`Better BibTeX API error: ${toErrorMessage(error)}`);
  }

  const responseSchema = z.object({
    jsonrpc: z.string(),
    id: z.number().nullish(),
    result: resultSchema.optional(),
    error: JsonRpcErrorSchema.optional(),
  });
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError(
      `Better BibTeX returned an unexpected response for ${method}: ${z.prettifyError(parsed.error)}`,
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

// ============================================================================
// Zotero Connector API — the endpoints `zotero_add` writes through. Requires
// Zotero desktop to be running; no authentication (purely local).
// ============================================================================

export interface ConnectorResult {
  status: 'success' | 'error';
  message?: string;
}

/**
 * Check if Zotero is running by pinging the connector.
 * Throws a user-friendly ToolError if not reachable.
 */
export async function checkZoteroRunning(port: number): Promise<void> {
  try {
    await ky.get(zoteroUrl(port, '/connector/ping'), {
      timeout: false,
      signal: AbortSignal.timeout(ZOTERO_PING_TIMEOUT_MS),
      retry: 0,
    });
  } catch {
    throw zoteroUnreachableError(port);
  }
}

/**
 * Call a Zotero Connector endpoint with unified error handling.
 */
export async function callZoteroConnector(
  endpoint: string,
  body: object,
  port: number,
): Promise<ConnectorResult> {
  let response: Response;
  try {
    response = await ky.post(zoteroUrl(port, `/connector/${endpoint}`), {
      json: body,
      timeout: false,
      signal: AbortSignal.timeout(ZOTERO_CONNECTOR_TIMEOUT_MS),
      retry: 0,
      throwHttpErrors: false,
    });
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      return {
        status: 'error',
        message:
          `Zotero Connector request timed out after ${ZOTERO_CONNECTOR_TIMEOUT_MS / 1000}s. ` +
          `Retry the request. If it persists, ask the user to check that Zotero is responsive.`,
      };
    }
    // TypeError from fetch (ECONNREFUSED → TypeError in native fetch): for a
    // localhost endpoint this is always a connection failure, so present the
    // same reachability guidance as checkZoteroRunning and callBetterBibTeX
    // instead of surfacing a raw 'TypeError: fetch failed'.
    if (error instanceof TypeError) {
      return { status: 'error', message: zoteroUnreachableError(port).message };
    }
    return { status: 'error', message: toErrorMessage(error) };
  }

  if (
    response.status === StatusCodes.OK ||
    response.status === StatusCodes.CREATED
  ) {
    return { status: 'success' };
  }

  // Try to extract a machine-readable error message from the response body.
  let errorMessage = `Unexpected response status: ${response.status}`;
  try {
    const data = (await response.json()) as { error?: string };
    if (data?.error) errorMessage = String(data.error);
  } catch {
    // Body is not JSON or is empty; use the generic status message.
  }
  return { status: 'error', message: errorMessage };
}
