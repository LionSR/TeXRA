/**
 * Add items to Zotero via the local Connector API (port 23119).
 *
 * This tool uses the Zotero Connector HTTP server which runs when Zotero
 * desktop is open. No authentication required - purely local communication.
 *
 * Capabilities:
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
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { ToolError } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import {
  callZoteroConnector,
  checkZoteroRunning,
  withZoteroPort,
  type ConnectorResult,
} from './bbtClient';

/**
 * Schema for a single item to add to Zotero.
 * Supports a URL snapshot or manual metadata entry.
 */
const ZoteroItemSchema = z
  .strictObject({
    url: z
      .string()
      .describe(
        'URL of the item to add. Zotero will try to extract metadata from the page.',
      )
      .nullish(),
    title: z
      .string()
      .describe('Title of the item (required if URL is not provided).')
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
    (data) => data.url || data.title,
    'At least one of url or title must be provided.',
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

/** A Zotero Connector `saveItems` creator entry: a parsed given/family name,
 *  or a single opaque name for organizations and unparsed CSL literals. */
type ZoteroCreator =
  | { firstName: string; lastName: string; creatorType: 'author' }
  | { name: string; creatorType: 'author' };

/** Canonical shape of a Zotero Connector `saveItems` item. */
interface ZoteroConnectorItem {
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  abstractNote?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
}

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
 * Add one item: an item with a URL is saved as a snapshot of that page;
 * otherwise its manual metadata is saved.
 */
const addItem = Effect.fn('ZoteroAddTool.addItem')(function* (
  item: z.infer<typeof ZoteroItemSchema>,
  port: number,
  collectionBody: object,
) {
  const itemLabel = item.url || item.title || 'Unknown item';
  const result: ConnectorResult = item.url
    ? yield* callZoteroConnector(
        'saveSnapshot',
        { url: item.url, ...collectionBody },
        port,
      )
    : yield* callZoteroConnector(
        'saveItems',
        { items: [toZoteroItem(item)], ...collectionBody },
        port,
      );
  return { item: itemLabel, ...result };
});

const addItems = Effect.fn('ZoteroAddTool.execute')(function* (
  { items, collection }: ZoteroAddInput,
  port: number,
) {
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

export const ZoteroAddTool = defineTool({
  name: 'zotero_add',
  description:
    'Add literature items to Zotero library. Requires Zotero to be running with the Connector enabled. Supports adding items by URL or manual metadata entry. When possible, check for duplicates first (via zotero_search or grepping .bib files).',
  schema: ZoteroAddInputSchema,
  execute: withZoteroPort(addItems),
});
