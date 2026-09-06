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
import { type Work } from '@jamesgopsill/crossref-client';
import { Data, Duration, Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import { ToolError, type ToolResult } from '@shared/schemas';
import { acquireRateLimitSlot } from '@tools/support/rateLimiter';
import { CROSSREF_CONSTANTS, CrossrefClient } from '@tools/citation/constants';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import {
  callZoteroConnector,
  checkZoteroRunning,
  getZoteroPort,
  type ConnectorResult,
} from './bbtClient';

const log = createLog('ZoteroAddTool');
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
        'Type of the item. Defaults to journalArticle. Use "preprint" for arXiv papers and other preprints: never use "webpage" for preprints.',
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

type ZoteroAddInput = z.infer<typeof ZoteroAddInputSchema>;

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

/** A Zotero Connector `saveItems` creator entry: a parsed given/family name,
 *  or a single opaque name for organizations and unparsed CSL literals. */
type ZoteroCreator =
  | { firstName: string; lastName: string; creatorType: 'author' }
  | { name: string; creatorType: 'author' };

/**
 * Canonical shape of a Zotero Connector `saveItems` item. Both `resolveDOI`
 * (Crossref-derived) and `toZoteroItem` (manual metadata) build this same
 * shape from different sources — sharing the type keeps a field renamed in
 * one path from silently drifting out of sync with the other.
 */
interface ZoteroConnectorItem {
  itemType: string;
  title?: string;
  DOI?: string;
  url?: string;
  creators?: ZoteroCreator[];
  date?: string;
  abstractNote?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
}

/**
 * A Crossref `Work.author` entry. The client types `given`/`family` as
 * required, but the API sends `name` (an opaque org/affiliation name) for
 * institutional authors and omits `given`/`family` then — so this shape
 * mirrors the wire format: person authors carry `given`+`family`, org
 * authors carry `name`. CSL's `literal` field never appears here.
 */
interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

/** The Crossref lookup for a DOI rejected or outlived its deadline. */
class CrossrefLookupFailed extends Data.TaggedError('CrossrefLookupFailed')<{
  readonly cause: unknown;
}> {}

/**
 * Fetch a DOI's Crossref work under the shared Crossref rate limit and a
 * deadline. The client has no timeout or cancellation hook of its own, so a
 * timed-out or cancelled lookup is abandoned — safe for this read-only call.
 */
const crossrefWork = Effect.fn('ZoteroAddTool.crossrefWork')(function* (
  doi: string,
) {
  yield* acquireRateLimitSlot(
    'crossref',
    CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
  );
  return yield* Effect.tryPromise({
    try: () => CrossrefClient.work(doi),
    catch: (cause) => new CrossrefLookupFailed({ cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(CROSSREF_RESOLVE_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new CrossrefLookupFailed({
            cause: new Error('Crossref lookup timed out'),
          }),
        ),
    }),
  );
});

/** Build the Zotero Connector item for a resolved Crossref work. */
function workToZoteroItem(doi: string, work: Work): ZoteroConnectorItem {
  const creators: ZoteroCreator[] | undefined = work.author?.length
    ? work.author.map((a: CrossrefAuthor) => {
        if (a.given && a.family) {
          return {
            firstName: a.given,
            lastName: a.family,
            creatorType: 'author' as const,
          };
        }
        // name = Crossref org author; a person author with no family name
        // (not a real Crossref shape) falls back to 'Unknown'.
        return {
          name: a.name || a.family || 'Unknown',
          creatorType: 'author' as const,
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

  const item: ZoteroConnectorItem = {
    itemType: CROSSREF_TYPE_MAP[work.type || ''] || 'journalArticle',
    DOI: doi,
  };
  if (work.title?.[0]) item.title = work.title[0];
  if (creators?.length) item.creators = creators;
  if (year != null) item.date = String(year);
  if (containerTitle) item.publicationTitle = containerTitle;
  if (work.volume) item.volume = String(work.volume);
  if (work.issue) item.issue = String(work.issue);
  if (work.page) item.pages = String(work.page);
  if (work.abstract) item.abstractNote = work.abstract;
  if (work.resource?.primary?.URL) item.url = work.resource.primary.URL;
  return item;
}

/**
 * Resolve a DOI to full metadata via the Crossref API.
 * Uses the shared CrossrefClient and rate limiter from @tools/citation.
 * Succeeds with a Zotero-format item object, or null if resolution fails;
 * an interrupted tool call stops here instead of degrading to the fallback
 * metadata.
 */
const resolveDOI = Effect.fn('ZoteroAddTool.resolveDOI')((doi: string) =>
  crossrefWork(doi).pipe(
    Effect.map((response) =>
      response.ok && response.content?.message
        ? workToZoteroItem(doi, response.content.message)
        : null,
    ),
    Effect.catchTag('CrossrefLookupFailed', (error) =>
      Effect.sync(() => {
        // The caller still falls back to the user's own metadata; log so a
        // silently degraded entry is traceable to the Crossref failure.
        log.warn(
          `Crossref lookup failed for DOI ${doi}: ${toErrorMessage(error.cause)}`,
        );
        return null;
      }),
    ),
  ),
);

/**
 * Convert our item schema to Zotero Connector format.
 */
function toZoteroItem(
  item: z.infer<typeof ZoteroItemSchema>,
): ZoteroConnectorItem {
  // Parse authors into Zotero creator format
  const creators: ZoteroCreator[] | undefined = item.authors?.length
    ? item.authors.map((name) => {
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) {
          return { name: parts[0], creatorType: 'author' as const };
        }
        const lastName = parts.pop() as string;
        const firstName = parts.join(' ');
        return { firstName, lastName, creatorType: 'author' as const };
      })
    : undefined;

  const result: ZoteroConnectorItem = {
    itemType: item.itemType || 'journalArticle',
  };
  if (item.title) result.title = item.title;
  if (item.doi) result.DOI = item.doi;
  if (item.url) result.url = item.url;
  if (creators) result.creators = creators;
  if (item.year) result.date = item.year;
  if (item.abstract) result.abstractNote = item.abstract;
  if (item.publicationTitle) result.publicationTitle = item.publicationTitle;
  if (item.volume) result.volume = item.volume;
  if (item.issue) result.issue = item.issue;
  if (item.pages) result.pages = item.pages;
  return result;
}

/**
 * Add one item: a URL-only item is saved as a snapshot; a DOI resolves its
 * metadata via Crossref, with the manual metadata as the fallback when that
 * lookup fails.
 */
const addItem = Effect.fn('ZoteroAddTool.addItem')(function* (
  item: z.infer<typeof ZoteroItemSchema>,
  port: number,
  collectionBody: object,
) {
  const itemLabel = item.doi || item.url || item.title || 'Unknown item';

  let result: ConnectorResult;
  if (!item.doi && item.url) {
    result = yield* callZoteroConnector(
      'saveSnapshot',
      { url: item.url, ...collectionBody },
      port,
    );
  } else {
    const resolved = item.doi
      ? yield* resolveDOI(item.doi)
      : toZoteroItem(item);
    const zoteroItem = resolved ?? (item.title ? toZoteroItem(item) : null);
    if (zoteroItem) {
      result = yield* callZoteroConnector(
        'saveItems',
        { items: [zoteroItem], ...collectionBody },
        port,
      );
    } else {
      result = {
        status: 'error',
        message: 'Crossref lookup failed and no title provided to fall back on',
      };
    }
  }

  return { item: itemLabel, ...result };
});

const addItems = Effect.fn('ZoteroAddTool.execute')(function* ({
  items,
  collection,
}: ZoteroAddInput) {
  const port = getZoteroPort();

  // Fails with a ToolError if Zotero is not running.
  yield* checkZoteroRunning(port);

  const collectionBody = collection ? { targetID: collection } : {};
  const results = yield* Effect.forEach(items, (item) =>
    addItem(item, port, collectionBody),
  );

  const successCount = results.filter((r) => r.status === 'success').length;
  const errorCount = results.length - successCount;

  const output = results
    .map((r) =>
      r.status === 'success' ? `✓ ${r.item}` : `✗ ${r.item}: ${r.message}`,
    )
    .join('\n');

  // Fail if all items failed (items.length >= 1 per schema)
  if (successCount === 0) {
    return yield* Effect.fail(
      new ToolError(
        `Failed to add all ${errorCount} ${pluralize(errorCount, 'item')} to Zotero:\n${output}`,
      ),
    );
  }

  const summary =
    errorCount === 0
      ? `Successfully added ${successCount} ${pluralize(successCount, 'item')} to Zotero.`
      : `Added ${successCount} ${pluralize(successCount, 'item')}, failed to add ${errorCount} ${pluralize(errorCount, 'item')} to Zotero.`;

  return executed(output, summary);
});

export class ZoteroAddTool extends defineTool({
  name: 'zotero_add',
  description:
    'Add literature items to Zotero library. Requires Zotero to be running with the Connector enabled. Supports adding items by DOI (recommended), URL, or manual metadata entry. When possible, check for duplicates first (via zotero_search or grepping .bib files).',
  schema: ZoteroAddInputSchema,
}) {
  protected execute(input: ZoteroAddInput): Promise<ToolResult> {
    return effectRuntime().runPromise(addItems(input), {
      signal: getCurrentToolCallContext()?.signal,
    });
  }
}
