// Third-party imports
import search from 'arxiv-api-ts';
import { z } from 'zod';

// Local imports - latex
import { arxivProcessor } from '@latex/arxivProcessor';
import {
  extractEntryIdentifier,
  getAuthorNames,
  normaliseArxivIdentifier,
  readPrimaryCategory,
} from './arxivShared';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const ArxivMetadataInputSchema = z.strictObject({
  id: z.string(),
  includeAbstract: z.boolean().optional(),
  maxAuthors: z.number().int().positive().max(50).optional(),
});

export type ArxivMetadataInput = z.infer<typeof ArxivMetadataInputSchema>;

export class ArxivMetadataTool extends defineTool({
  name: 'arxiv_metadata',
  description: 'Fetch bibliographic metadata for an arXiv paper.',
  schema: ArxivMetadataInputSchema,
}) {
  protected async execute(input: ArxivMetadataInput) {
    const rawId = input.id.trim();
    const validationError = arxivProcessor.validateId(rawId);
    if (validationError) {
      throw new ToolError(validationError);
    }

    const requestId = normaliseArxivIdentifier(rawId);
    const baseId = requestId.replace(/v\d+$/i, '');

    let response;
    try {
      response = await search({
        searchQueryParams: [
          {
            include: [
              {
                name: requestId,
              },
            ],
          },
        ],
        maxResults: 25,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to query arXiv API: ${message}`);
    }

    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const targetEntry = entries.find((entry) => {
      const entryId = extractEntryIdentifier(entry?.id);
      if (!entryId) {
        return false;
      }
      if (entryId === requestId) {
        return true;
      }
      const candidateBase = entryId.replace(/v\d+$/i, '');
      return candidateBase === baseId;
    });

    if (!targetEntry) {
      throw new ToolError(`No metadata found for arXiv ID ${requestId}`);
    }

    const authorNames = getAuthorNames(targetEntry.authors, input.maxAuthors);
    const includeAbstract = input.includeAbstract !== false;

    const metadata = {
      id: extractEntryIdentifier(targetEntry.id) ?? requestId,
      doi: targetEntry.doi ?? null,
      title:
        typeof targetEntry.title === 'string'
          ? targetEntry.title.trim()
          : targetEntry.title,
      summary: includeAbstract ? (targetEntry.summary ?? null) : undefined,
      published: targetEntry.published ?? null,
      updated: targetEntry.updated ?? null,
      authors: authorNames,
      journalReference: targetEntry.journalReference ?? null,
      comment: targetEntry.comment ?? null,
      primaryCategory: readPrimaryCategory(targetEntry.primaryCategory),
      links: targetEntry.links ?? null,
    };

    return toolResult({
      summary: `Retrieved metadata for arXiv ID ${metadata.id}`,
      output: JSON.stringify(metadata, null, 2),
    });
  }
}
