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

const ArxivMetadataInputSchema = z.strictObject({
  id: z.string(),
  includeAbstract: z.boolean().optional(),
});

export type ArxivMetadataInput = z.infer<typeof ArxivMetadataInputSchema>;

const formatMetadataOutput = (
  metadata: NormalizedArxivEntry,
  includeAbstract: boolean,
): string => {
  const lines: string[] = [];

  lines.push(
    formatToolOutput(
      'Basic information',
      [
        `**Title:** ${metadata.title}`,
        `**ArXiv ID:** ${metadata.arxivId}`,
        `**DOI:** ${metadata.doi ?? 'Not available'}`,
        `**Published:** ${metadata.published ?? 'Unknown'}`,
        `**Last updated:** ${metadata.updated ?? 'Unknown'}`,
        `**Primary category:** ${metadata.primaryCategory ?? 'Unknown'}`,
        `**Categories:** ${
          metadata.categories.length > 0
            ? metadata.categories.join(', ')
            : 'Not listed'
        }`,
        `**Authors:** ${
          metadata.authors.length > 0
            ? metadata.authors.join(', ')
            : 'Not listed'
        }`,
        metadata.comment ? `**Comment:** ${metadata.comment}` : undefined,
        metadata.journalReference
          ? `**Journal reference:** ${metadata.journalReference}`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
    ),
  );

  const linkLines: string[] = [];
  if (metadata.htmlUrl) {
    linkLines.push(`- [Abstract page](${metadata.htmlUrl})`);
  }
  if (metadata.pdfUrl) {
    linkLines.push(`- [PDF download](${metadata.pdfUrl})`);
  }
  if (metadata.doi) {
    linkLines.push(`- [DOI link](https://doi.org/${metadata.doi})`);
  }
  if (linkLines.length > 0) {
    lines.push(formatToolOutput('Links', linkLines.join('\n')));
  }

  if (includeAbstract && metadata.summary) {
    lines.push(formatToolOutput('Abstract', metadata.summary));
  }

  return lines.join('\n\n');
};

export class ArxivMetadataTool extends defineTool({
  name: 'get_arxiv_metadata',
  description:
    'Fetch citation metadata for a specific arXiv identifier, including DOI and author details.',
  schema: ArxivMetadataInputSchema,
}) {
  protected async execute(input: ArxivMetadataInput) {
    const requestedId = input.id.trim();
    const validationError = arxivProcessor.validateId(requestedId);

    if (validationError) {
      throw new ToolError(validationError);
    }

    const url = new URL('https://export.arxiv.org/api/query');
    url.searchParams.set('search_query', `id:${requestedId}`);
    url.searchParams.set('max_results', '5');

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'TeXRA arXiv metadata tool',
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
      throw new ToolError(
        'No metadata was returned for the requested arXiv identifier.',
      );
    }

    const normalizedEntries = entries.map((entry) =>
      parseArxivEntry(entry, requestedId),
    );

    const metadata =
      normalizedEntries.find((entry) => entry.arxivId === requestedId) ??
      normalizedEntries[0];

    const summary = `Retrieved metadata for arXiv ${metadata.arxivId}: ${metadata.title}`;
    const output = formatMetadataOutput(
      metadata,
      input.includeAbstract ?? true,
    );

    return toolResult({
      summary,
      output,
    });
  }
}
