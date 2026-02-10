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
import axios, { AxiosError } from 'axios';
import { type Work } from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { CROSSREF_CONSTANTS, crossrefClient } from '@tools/citation/constants';
import { waitForRateLimit } from '@tools/citation/rateLimiter';
import { ToolError } from '@tools/result';
import { isTimeoutErrorCode, buildTimeoutMessage } from '@tools/timeouts';
import { pluralize } from '@tools/utils';
import { defineTool } from '@tools/core/define';

// Local imports - zotero
import { getZoteroPort } from './bbtClient';

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
      .describe('Type of the item. Defaults to journalArticle.')
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
    const response = await axios.get(
      `http://127.0.0.1:${port}/connector/ping`,
      { timeout: ZOTERO_PING_TIMEOUT_MS },
    );
    if (response.status !== 200) {
      throw new Error('Unexpected response');
    }
  } catch {
    throw new ToolError(
      `Please start Zotero desktop app. The Connector API is not responding on port ${port}.`,
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
  try {
    const response = await axios.post(
      `http://127.0.0.1:${port}/connector/${endpoint}`,
      body,
      {
        timeout: ZOTERO_CONNECTOR_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (response.status === 200 || response.status === 201) {
      return { status: 'success' };
    }
    return {
      status: 'error',
      message: `Unexpected response status: ${response.status}`,
    };
  } catch (error) {
    if (error instanceof AxiosError && isTimeoutErrorCode(error.code)) {
      return {
        status: 'error',
        message: buildTimeoutMessage(
          'Zotero Connector request',
          ZOTERO_CONNECTOR_TIMEOUT_MS,
        ),
      };
    }
    const message =
      error instanceof AxiosError && error.response?.data?.error
        ? String(error.response.data.error)
        : toErrorMessage(error);
    return { status: 'error', message };
  }
}

/** Map Crossref document types to Zotero item types. */
const CROSSREF_TYPE_MAP: Record<string, string> = {
  'journal-article': 'journalArticle',
  book: 'book',
  'book-chapter': 'bookSection',
  'proceedings-article': 'conferencePaper',
  dissertation: 'thesis',
  report: 'report',
  'posted-content': 'preprint',
  monograph: 'book',
  dataset: 'document',
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
    const response = await Promise.race([
      crossrefClient.work(doi),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Crossref lookup timed out')),
          CROSSREF_RESOLVE_TIMEOUT_MS,
        ),
      ),
    ]);

    if (!response.ok || !response.content?.message) return null;

    const work: Work = response.content.message;

    // Access fields that may not be in the library's Work type definition
    const raw = work as Record<string, unknown>;

    const creators = work.author?.length
      ? work.author.map(
          (a: { given?: string; family?: string; name?: string }) => {
            if (a.given && a.family) {
              return {
                firstName: a.given,
                lastName: a.family,
                creatorType: 'author',
              };
            }
            return {
              name: a.name || a.family || 'Unknown',
              creatorType: 'author',
            };
          },
        )
      : undefined;

    // Extract year from published or created date-parts
    const year =
      work.published?.['date-parts']?.[0]?.[0] ??
      work.created?.['date-parts']?.[0]?.[0];

    // container-title is an array in Crossref responses (may be empty)
    const rawContainer = Array.isArray(raw['container-title'])
      ? raw['container-title'][0]
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
      ...(raw.volume && { volume: String(raw.volume) }),
      ...(raw.issue && { issue: String(raw.issue) }),
      ...(raw.page && { pages: String(raw.page) }),
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

  // Build Zotero item, filtering out undefined values
  const zoteroItem: Record<string, unknown> = {
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

  return zoteroItem;
}

export class ZoteroAddTool extends defineTool({
  name: 'zotero_add',
  description:
    'Add literature items to Zotero library. Requires Zotero to be running with the Connector enabled. Supports adding items by DOI (recommended), URL, or manual metadata entry.',
  schema: ZoteroAddInputSchema,
}) {
  protected async execute({ items, collection }: ZoteroAddInput) {
    const port = getZoteroPort();

    // Check if Zotero is running (throws ToolError if not)
    await checkZoteroRunning(port);

    const results: Array<{
      item: string;
      status: 'success' | 'error';
      message?: string;
    }> = [];

    for (const item of items) {
      const itemLabel = item.doi || item.url || item.title || 'Unknown item';
      const collectionBody = collection ? { targetID: collection } : {};

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

    let successCount = 0;
    let errorCount = 0;
    for (const r of results) {
      if (r.status === 'success') successCount++;
      else if (r.status === 'error') errorCount++;
    }

    const output = results
      .map((r) => {
        if (r.status === 'success') {
          return `✓ ${r.item}`;
        }
        return `✗ ${r.item}: ${r.message}`;
      })
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
      summary,
      output,
    };
  }
}
