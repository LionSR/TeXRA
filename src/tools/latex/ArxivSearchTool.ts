// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { arxivProcessor } from '@latex/arxivProcessor';

// Local imports - latex utils
import {
  NormalizedArxivEntry,
  arxivParser,
  parseArxivEntry,
  toArray,
} from './arxivUtils';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';
import { formatToolOutput } from '../utils';

const SORT_BY_VALUES = [
  'relevance',
  'lastUpdatedDate',
  'submittedDate',
] as const;
const SORT_ORDER_VALUES = ['ascending', 'descending'] as const;

const ArxivSearchInputSchema = z.strictObject({
  query: z.string().min(1, 'Provide at least one search term.'),
  author: z.string().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  start: z.number().int().min(0).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  sortBy: z.enum(SORT_BY_VALUES).optional(),
  sortOrder: z.enum(SORT_ORDER_VALUES).optional(),
  includeAbstract: z.boolean().optional(),
});

export type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

const sanitizeTerm = (term: string): string => {
  const trimmed = term.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const cleaned = trimmed.replace(/"/g, '');
  return cleaned.includes(' ') ? `"${cleaned}"` : cleaned;
};

const appendTerm = (
  parts: string[],
  prefix: string,
  rawValue: string | undefined,
): void => {
  if (!rawValue) {
    return;
  }

  const sanitized = sanitizeTerm(rawValue);
  if (sanitized.length === 0) {
    return;
  }

  parts.push(`${prefix}:${sanitized}`);
};

const buildSearchQuery = (input: ArxivSearchInput): string => {
  const segments: string[] = [];

  appendTerm(segments, 'all', input.query);
  appendTerm(segments, 'ti', input.title);
  appendTerm(segments, 'au', input.author);

  if (input.category) {
    input.category
      .split(',')
      .forEach((value) => appendTerm(segments, 'cat', value));
  }

  return segments.join(' AND ');
};

const formatEntry = (
  entry: NormalizedArxivEntry,
  index: number,
  includeAbstract: boolean,
): string => {
  const lines: string[] = [
    `**Title:** ${entry.title}`,
    `**ArXiv ID:** ${entry.arxivId}`,
    entry.doi ? `**DOI:** ${entry.doi}` : undefined,
    `**Authors:** ${entry.authors.length > 0 ? entry.authors.join(', ') : 'Not listed'}`,
    entry.categories.length > 0
      ? `**Categories:** ${entry.categories.join(', ')}`
      : undefined,
    entry.published ? `**Published:** ${entry.published}` : undefined,
    entry.updated ? `**Updated:** ${entry.updated}` : undefined,
    entry.comment ? `**Comment:** ${entry.comment}` : undefined,
    entry.journalReference
      ? `**Journal reference:** ${entry.journalReference}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  const links: string[] = [];
  if (entry.htmlUrl) {
    links.push(`- [Abstract page](${entry.htmlUrl})`);
  }
  if (entry.pdfUrl) {
    links.push(`- [PDF download](${entry.pdfUrl})`);
  }
  if (entry.doi) {
    links.push(`- [DOI link](https://doi.org/${entry.doi})`);
  }

  if (links.length > 0) {
    lines.push('**Links:**');
    lines.push(...links);
  }

  if (includeAbstract && entry.summary) {
    lines.push('', entry.summary);
  }

  return formatToolOutput(`${index + 1}. ${entry.title}`, lines.join('\n'));
};

export class ArxivSearchTool extends defineTool({
  name: 'search_arxiv',
  description:
    'Search the arXiv catalogue by keyword, author, title, or category and return structured matches.',
  schema: ArxivSearchInputSchema,
}) {
  protected async execute(input: ArxivSearchInput) {
    const validationError = arxivProcessor.validateId(input.query.trim());
    const hasExactIdQuery = !validationError;

    const query = buildSearchQuery(input);
    if (!query) {
      throw new ToolError(
        'Unable to build search query. Provide at least one valid filter.',
      );
    }

    const url = new URL('https://export.arxiv.org/api/query');
    url.searchParams.set('search_query', query);
    url.searchParams.set('max_results', String(input.maxResults ?? 10));
    url.searchParams.set('start', String(input.start ?? 0));
    if (input.sortBy) {
      url.searchParams.set('sortBy', input.sortBy);
    }
    if (input.sortOrder) {
      url.searchParams.set('sortOrder', input.sortOrder);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'TeXRA arXiv search tool',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to reach arXiv API: ${message}`);
    }

    if (!response.ok) {
      throw new ToolError(
        `arXiv API request failed with status ${response.status}`,
      );
    }

    const xml = await response.text();

    let parsed: Record<string, any>;
    try {
      parsed = arxivParser.parse(xml) as Record<string, any>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to parse arXiv response: ${message}`);
    }

    const entries = toArray(parsed.feed?.entry);
    if (entries.length === 0) {
      return toolResult({
        summary: 'No arXiv results found for the supplied query.',
        output: 'The search did not return any matches.',
      });
    }

    const normalized = entries.map((entry) =>
      parseArxivEntry(entry, input.query.trim()),
    );
    const includeAbstract = input.includeAbstract ?? false;

    const outputSections = normalized.map((entry, index) =>
      formatEntry(entry, index, includeAbstract),
    );

    const summary = hasExactIdQuery
      ? `Retrieved ${normalized.length} result(s) for arXiv ID ${input.query.trim()}.`
      : `Retrieved ${normalized.length} arXiv result(s) matching "${input.query.trim()}".`;

    return toolResult({
      summary,
      output: outputSections.join('\n\n'),
    });
  }
}
