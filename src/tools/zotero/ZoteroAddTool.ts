// Third-party imports
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

// Local imports - core
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { getConfig } from '@utils/config';

/**
 * Schema for a single item to add to Zotero.
 * Supports DOI-based lookup or manual metadata entry.
 */
const ZoteroItemSchema = z
  .strictObject({
    doi: z
      .string()
      .describe(
        'DOI of the item to add. If provided, Zotero will fetch metadata automatically.',
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
 */
async function isZoteroRunning(port: number): Promise<boolean> {
  try {
    const response = await axios.get(
      `http://127.0.0.1:${port}/connector/ping`,
      { timeout: 2000 },
    );
    return response.status === 200;
  } catch {
    return false;
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
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } },
    );
    if (response.status === 200 || response.status === 201) {
      return { status: 'success' };
    }
    return {
      status: 'error',
      message: `Unexpected response status: ${response.status}`,
    };
  } catch (error) {
    const message =
      error instanceof AxiosError && error.response?.data?.error
        ? String(error.response.data.error)
        : toErrorMessage(error);
    return { status: 'error', message };
  }
}

/**
 * Convert our item schema to Zotero Connector format.
 */
function toZoteroItem(item: z.infer<typeof ZoteroItemSchema>): object {
  const zoteroItem: Record<string, unknown> = {
    itemType: item.itemType || 'journalArticle',
  };

  if (item.title) {
    zoteroItem.title = item.title;
  }

  if (item.doi) {
    zoteroItem.DOI = item.doi;
  }

  if (item.url) {
    zoteroItem.url = item.url;
  }

  if (item.authors && item.authors.length > 0) {
    zoteroItem.creators = item.authors.map((name) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) {
        return { name: parts[0], creatorType: 'author' };
      }
      const lastName = parts.pop();
      const firstName = parts.join(' ');
      return { firstName, lastName, creatorType: 'author' };
    });
  }

  if (item.year) {
    zoteroItem.date = item.year;
  }

  if (item.abstract) {
    zoteroItem.abstractNote = item.abstract;
  }

  if (item.publicationTitle) {
    zoteroItem.publicationTitle = item.publicationTitle;
  }

  if (item.volume) {
    zoteroItem.volume = item.volume;
  }

  if (item.issue) {
    zoteroItem.issue = item.issue;
  }

  if (item.pages) {
    zoteroItem.pages = item.pages;
  }

  return zoteroItem;
}

export class ZoteroAddTool extends defineTool({
  name: 'zotero_add',
  description:
    'Add literature items to Zotero library. Requires Zotero to be running with the Connector enabled. Supports adding items by DOI (recommended), URL, or manual metadata entry.',
  schema: ZoteroAddInputSchema,
}) {
  protected async execute({ items, collection }: ZoteroAddInput) {
    const port = getConfig<number>('texra.bib.zoteroConnectorPort', 23119);

    // Check if Zotero is running
    const running = await isZoteroRunning(port);
    if (!running) {
      throw new ToolError(
        'Zotero is not running or the Connector is not enabled. ' +
          'Please start Zotero and ensure the Connector is active on port ' +
          `${port}. You can change the port in VS Code settings under ` +
          '"texra.bib.zoteroConnectorPort".',
      );
    }

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
        result = await callZoteroConnector(
          'saveDOI',
          { doi: item.doi, ...collectionBody },
          port,
        );
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
    const errorCount = results.filter((r) => r.status === 'error').length;

    let summary: string;
    if (errorCount === 0) {
      summary = `Successfully added ${successCount} item${successCount === 1 ? '' : 's'} to Zotero.`;
    } else if (successCount === 0) {
      summary = `Failed to add ${errorCount} item${errorCount === 1 ? '' : 's'} to Zotero.`;
    } else {
      summary = `Added ${successCount} item${successCount === 1 ? '' : 's'}, failed to add ${errorCount} item${errorCount === 1 ? '' : 's'} to Zotero.`;
    }

    const output = results
      .map((r) => {
        if (r.status === 'success') {
          return `✓ ${r.item}`;
        }
        return `✗ ${r.item}: ${r.message}`;
      })
      .join('\n');

    return {
      summary,
      output,
    };
  }
}
