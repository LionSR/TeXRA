/**
 * Add items to Zotero via the local Connector API (port 23119).
 *
 * This tool uses the Zotero Connector HTTP server which runs when Zotero
 * desktop is open. No authentication required - purely local communication.
 *
 * Capabilities:
 * - Add items by DOI (recommended - metadata resolved via Crossref)
 * - Add items by URL (Zotero extracts metadata from page)
 * - Add items with manual metadata (title, authors, year, etc.)
 *
 * Related tools (require Better BibTeX plugin):
 * - zotero_search: Search library via BBT JSON-RPC (item.search)
 * - zotero_export: Export BibTeX via BBT JSON-RPC (item.export)
 *
 * See: https://www.zotero.org/support/dev/client_coding/connector_http_server
 */

// Third-party imports
import ky from 'ky';
import { type Work } from '@jamesgopsill/crossref-client';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import pTimeout from 'p-timeout';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { isTimeoutError } from '@tools/timeouts';
import { waitForRateLimit } from '@tools/citation/rateLimiter';
import { CROSSREF_CONSTANTS, CrossrefClient } from '@tools/citation/constants';
import { defineTool } from '@tools/core/define';
import { pluralize } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { type CslCreator, getZoteroPort } from './bbtClient';

const ZOTERO_PING_TIMEOUT_MS = 2_000; // 2 s
const ZOTERO_CONNECTOR_TIMEOUT_MS = 30_000; // 30 s
const CROSSREF_RESOLVE_TIMEOUT_MS = 15_000; // 15 s

/**
 * Schema for a single item to add to Zotero.
 * Supports DOI-based lookup or manual metadata entry.
 */
const ZoteroItemSchema = z
  .strictObject({
    doi: z
      .string()
      .describe(
        'DOI of the item to add. Metadata is resolved via Crossref before saving.',
      )
      .nullish(),
    url: z
      .string()
      .describe(
        'URL of the item to add. Zotero will try to extract metadata from the page.',
      )
      .nullish(),
    title: z
      .string()
      .describe('Title of the item (required if DOI and URL are not provided).')
      .nullish(),
    authors: z
      .array(z.string())
      .describe('List of author names (e.g., ["John Smith", "Jane Doe"]).')
      .nullish(),
    year: z.string().describe('Publication year.').nullish(),
    itemType: z
      .enum([
        'journalArticle',
        'book',
        'bookSection',
        'conferencePaper',
        'thesis',
        'report',
        'webpage',
        'preprint',
      ])
      .describe(
        'Type of the item. Defaults to journalArticle. Use "preprint" for arXiv papers and other preprints — never use "webpage" for preprints.',
      )
      .nullish(),
    abstract: z.string().describe('Abstract of the item.').nullish(),
    publicationTitle: z
      .string()
      .describe('Journal or publication name.')
      .nullish(),
    volume: z.string().describe('Volume number.').nullish(),
    issue: z.string().describe('Issue number.').nullish(),
    pages: z.string().describe('Page range (e.g., "123-456").').nullish(),
  })
  .refine(
    (data) => data.doi || data.url || data.title,
    'At least one of doi, url, or title must be provided.',
  );

const ZoteroAddInputSchema = z.strictObject({
  items: z
    .array(ZoteroItemSchema)
    .min(1, 'At least one item must be provided.')
    .max(10, 'Maximum 10 items can be added at once.')
    .describe('List of items to add to Zotero.'),
  collection: z
    .string()
    .describe('Optional collection key to add items to.')
    .nullish(),
});

export type ZoteroAddInput = z.infer<typeof ZoteroAddInputSchema>;

interface ConnectorResult {
  status: 'success' | 'error';
  message?: string;
}

/**
 * Check if Zotero is running by pinging the connector.
 * Throws a user-friendly ToolError if not reachable.
 */
async function checkZoteroRunning(port: number): Promise<void> {
  try {
    await ky.get(`http://127.0.0.1:${port}/connector/ping`, {
      timeout: false,
      signal: AbortSignal.timeout(ZOTERO_PING_TIMEOUT_MS),
      retry: 0,
    });
  } catch {
    throw new ToolError(
      `Zotero is not reachable on port ${port}. ` +
        `Ask the user to start Zotero or verify the port (setting: texra.bib.zoteroPort).`,
    );
  }
}

/**
 * Call a Zotero Connector endpoint with unified error handling.
 */
async function callZoteroConnector(
  endpoint: string,
  body: object,
  port: number,
): Promise<ConnectorResult> {
  let response: Response;
  try {
    response = await ky.post(`http://127.0.0.1:${port}/connector/${endpoint}`, {
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

/**
 * Map Crossref work types to Zotero item types.
 * Full list of Crossref types: https://api.crossref.org/types
 * Full list of Zotero types: https://api.zotero.org/schema
 */
const CROSSREF_TYPE_MAP: Record<string, string> = {
  // Journals
  'journal-article': 'journalArticle',
  // Books
  book: 'book',
  'edited-book': 'book',
  monograph: 'book',
  'reference-book': 'book',
  'book-series': 'book',
  'book-set': 'book',
  // Book sections
  'book-chapter': 'bookSection',
  'book-part': 'bookSection',
  'book-section': 'bookSection',
  'book-track': 'bookSection',
  // Reference works
  'reference-entry': 'encyclopediaArticle',
  // Conference
  'proceedings-article': 'conferencePaper',
  proceedings: 'conferencePaper',
  'proceedings-series': 'conferencePaper',
  // Academic
  dissertation: 'thesis',
  'posted-content': 'preprint',
  'peer-review': 'journalArticle',
  // Reports & standards
  report: 'report',
  'report-series': 'report',
  standard: 'standard',
  'standard-series': 'standard',
  // Data & other
  dataset: 'dataset',
  database: 'dataset',
  component: 'document',
  grant: 'document',
  other: 'document',
};

/**
 * Resolve a DOI to full metadata via the Crossref API.
 * Uses the shared CrossrefClient and rate limiter from @tools/citation.
 * Returns a Zotero-format item object, or null if resolution fails.
 */
async function resolveDOI(
  doi: string,
): Promise<Record<string, unknown> | null> {
  try {
    await waitForRateLimit('crossref', CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS);

    // The CrossrefClient has no timeout support, so we race against one.
    const response = await pTimeout(CrossrefClient.work(doi), {
      milliseconds: CROSSREF_RESOLVE_TIMEOUT_MS,
      message: 'Crossref lookup timed out',
    });

    if (!response.ok || !response.content?.message) return null;

    const work: Work = response.content.message;

    const creators = work.author?.length
      ? work.author.map((a: CslCreator) => {
          if (a.given && a.family) {
            return {
              firstName: a.given,
              lastName: a.family,
              creatorType: 'author',
            };
          }
          // name = Crossref org author, literal = CSL unparsed name
          return {
            name: a.name || a.literal || a.family || 'Unknown',
            creatorType: 'author',
          };
        })
      : undefined;

    // Extract year from published or created dateParts
    const year =
      work.published?.dateParts?.[0]?.[0] ?? work.created?.dateParts?.[0]?.[0];

    // containerTitle is an array in Crossref responses (may be empty)
    const rawContainer = Array.isArray(work.containerTitle)
      ? work.containerTitle[0]
      : undefined;
    const containerTitle =
      rawContainer != null ? String(rawContainer) : undefined;

    return {
      itemType: CROSSREF_TYPE_MAP[work.type || ''] || 'journalArticle',
      ...(work.title?.[0] && { title: work.title[0] }),
      DOI: doi,
      ...(creators?.length && { creators }),

      ...(year != null && { date: String(year) }),
      ...(containerTitle && { publicationTitle: containerTitle }),
      ...(work.volume && { volume: String(work.volume) }),
      ...(work.issue && { issue: String(work.issue) }),
      ...(work.page && { pages: String(work.page) }),
      ...(work.abstract && { abstractNote: work.abstract }),
      ...(work.resource?.primary?.URL && { url: work.resource.primary.URL }),
    };
  } catch {
    return null;
  }
}

/**
 * Convert our item schema to Zotero Connector format.
 */
function toZoteroItem(item: z.infer<typeof ZoteroItemSchema>): object {
  // Parse authors into Zotero creator format
  const creators = item.authors?.length
    ? item.authors.map((name) => {
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) {
          return { name: parts[0], creatorType: 'author' };
        }
        const lastName = parts.pop();
        const firstName = parts.join(' ');
        return { firstName, lastName, creatorType: 'author' };
      })
    : undefined;

  return {
    itemType: item.itemType || 'journalArticle',
    ...(item.title && { title: item.title }),
    ...(item.doi && { DOI: item.doi }),
    ...(item.url && { url: item.url }),
    ...(creators && { creators }),
    ...(item.year && { date: item.year }),
    ...(item.abstract && { abstractNote: item.abstract }),
    ...(item.publicationTitle && { publicationTitle: item.publicationTitle }),
    ...(item.volume && { volume: item.volume }),
    ...(item.issue && { issue: item.issue }),
    ...(item.pages && { pages: item.pages }),
  };
}

export class ZoteroAddTool extends defineTool({
  name: 'zotero_add',
  description:
    'Add literature items to Zotero library. Requires Zotero to be running with the Connector enabled. Supports adding items by DOI (recommended), URL, or manual metadata entry. When possible, check for duplicates first (via zotero_search or grepping .bib files). Use itemType "preprint" for arXiv papers and preprints — never "webpage".',
  schema: ZoteroAddInputSchema,
}) {
  protected async execute({
    items,
    collection,
  }: ZoteroAddInput): Promise<ToolResult> {
    const port = getZoteroPort();

    // Check if Zotero is running (throws ToolError if not)
    await checkZoteroRunning(port);

    const results: Array<ConnectorResult & { item: string }> = [];
    const collectionBody = collection ? { targetID: collection } : {};

    for (const item of items) {
      const itemLabel = item.doi || item.url || item.title || 'Unknown item';

      let result: ConnectorResult;

      if (item.doi) {
        // Resolve DOI metadata via Crossref, then use saveItems
        const resolvedItem = await resolveDOI(item.doi);
        if (resolvedItem) {
          result = await callZoteroConnector(
            'saveItems',
            { items: [resolvedItem], ...collectionBody },
            port,
          );
        } else if (item.title) {
          // Crossref failed but we have manual metadata to fall back on
          result = await callZoteroConnector(
            'saveItems',
            { items: [toZoteroItem(item)], ...collectionBody },
            port,
          );
        } else {
          result = {
            status: 'error',
            message:
              'Crossref lookup failed and no title provided to fall back on',
          };
        }
      } else if (item.url) {
        result = await callZoteroConnector(
          'saveSnapshot',
          { url: item.url, ...collectionBody },
          port,
        );
      } else {
        const zoteroItem = toZoteroItem(item);
        result = await callZoteroConnector(
          'saveItems',
          { items: [zoteroItem], ...collectionBody },
          port,
        );
      }

      results.push({ item: itemLabel, ...result });
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const errorCount = results.length - successCount;

    const output = results
      .map((r) =>
        r.status === 'success' ? `✓ ${r.item}` : `✗ ${r.item}: ${r.message}`,
      )
      .join('\n');

    // Throw ToolError if all items failed
    if (successCount === 0 && items.length > 0) {
      throw new ToolError(
        `Failed to add all ${errorCount} ${pluralize(errorCount, 'item')} to Zotero:\n${output}`,
      );
    }

    const summary =
      errorCount === 0
        ? `Successfully added ${successCount} ${pluralize(successCount, 'item')} to Zotero.`
        : `Added ${successCount} ${pluralize(successCount, 'item')}, failed to add ${errorCount} ${pluralize(errorCount, 'item')} to Zotero.`;

    return {
      status: 'executed',
      summary,
      output,
    };
  }
}
