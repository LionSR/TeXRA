// Third-party imports
import api, { ZoteroApiResponse } from 'zotero-api-client';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';
import { formatToolOutput } from '../utils';

const DoiSearchInputSchema = z.strictObject({
  query: z.string().min(1, 'Provide text to search for.'),
  apiKey: z.string().optional(),
  libraryType: z.enum(['user', 'group']).optional(),
  libraryId: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  qmode: z.string().optional(),
  sort: z.string().optional(),
});

export type DoiSearchInput = z.infer<typeof DoiSearchInputSchema>;

type ZoteroItem = {
  key?: string;
  title?: string;
  DOI?: string;
  date?: string;
  url?: string;
  abstractNote?: string;
  extra?: string;
  creators?: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  [key: string]: unknown;
};

type ZoteroResponseData =
  | Array<{ data?: ZoteroItem } | ZoteroItem>
  | ZoteroItem
  | undefined;

const toArray = (value: ZoteroResponseData): ZoteroItem[] => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry && typeof entry === 'object' && 'data' in entry) {
        const wrapped = entry as { data?: ZoteroItem };
        return wrapped.data ?? {};
      }

      return (entry ?? {}) as ZoteroItem;
    });
  }

  return [value as ZoteroItem];
};

const formatCreators = (item: ZoteroItem): string => {
  const creators = item.creators ?? [];
  const names = creators
    .map((creator) => {
      if (creator.name && creator.name.trim().length > 0) {
        return creator.name.trim();
      }

      const parts = [creator.firstName, creator.lastName].filter(
        (part): part is string => Boolean(part && part.trim().length > 0),
      );

      return parts.length > 0 ? parts.join(' ') : undefined;
    })
    .filter((name): name is string => Boolean(name));

  return names.length > 0 ? names.join(', ') : 'Not listed';
};

const formatResult = (item: ZoteroItem, index: number): string => {
  const lines: string[] = [
    `**Title:** ${item.title ?? 'Untitled item'}`,
    item.DOI ? `**DOI:** ${item.DOI}` : undefined,
    `**Creators:** ${formatCreators(item)}`,
    item.date ? `**Date:** ${item.date}` : undefined,
    item.url ? `**URL:** ${item.url}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (item.abstractNote) {
    lines.push('', item.abstractNote);
  }

  return formatToolOutput(
    `${index + 1}. ${item.title ?? 'Untitled item'}`,
    lines.join('\n'),
  );
};

const requireLibraryConfiguration = (input: DoiSearchInput) => {
  if (!input.libraryType || typeof input.libraryId !== 'number') {
    throw new ToolError(
      'Zotero queries require both libraryType ("user" or "group") and libraryId.',
    );
  }
};

export class DoiSearchTool extends defineTool({
  name: 'search_doi',
  description:
    'Search a configured Zotero library for items matching the query and surface DOI details.',
  schema: DoiSearchInputSchema,
}) {
  protected async execute(input: DoiSearchInput) {
    requireLibraryConfiguration(input);

    let client = api(input.apiKey ?? '');
    client = client.library(input.libraryType!, input.libraryId!);
    client = client.items();

    const requestOptions: Record<string, unknown> = {
      q: input.query,
      limit: input.limit ?? 10,
      include: 'data',
    };

    if (input.qmode) {
      requestOptions.qmode = input.qmode;
    }

    if (input.sort) {
      requestOptions.sort = input.sort;
    }

    let response: ZoteroApiResponse<ZoteroResponseData>;
    try {
      response = await client.get(requestOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Zotero API request failed: ${message}`);
    }

    const items = toArray(response.getData());

    if (items.length === 0) {
      return toolResult({
        summary: 'No Zotero items matched the requested query.',
        output: 'The search did not return any records.',
      });
    }

    const outputSections = items.map((item, index) =>
      formatResult(item, index),
    );

    return toolResult({
      summary: `Retrieved ${items.length} Zotero item(s) for "${input.query.trim()}".`,
      output: outputSections.join('\n\n'),
    });
  }
}
