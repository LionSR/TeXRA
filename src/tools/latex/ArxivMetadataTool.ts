// Third-party imports
import arxivClient from 'arxiv-client';
import { z } from 'zod';

// Local imports - latex
import { arxivProcessor } from '@latex/arxivProcessor';
import {
  type ArxivPaperMetadata,
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

    let entries;
    try {
      // Use arxiv-client's ids() method for direct ID lookup
      entries = await arxivClient.ids([requestId]).execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to query arXiv API: ${message}`);
    }

    if (!entries || entries.length === 0) {
      throw new ToolError(`No metadata found for arXiv ID ${requestId}`);
    }

    // Take the first result (should be the only one for ID lookup)
    const targetEntry = entries[0];

    const authorNames = getAuthorNames(targetEntry.authors, input.maxAuthors);
    const includeAbstract = input.includeAbstract !== false;

    const metadata: ArxivPaperMetadata = {
      id: extractEntryIdentifier(targetEntry.id) ?? requestId,
      doi: targetEntry.doi?.id ?? null,
      title:
        typeof targetEntry.title === 'string'
          ? targetEntry.title.trim()
          : targetEntry.title,
      abstract: includeAbstract ? (targetEntry.summary ?? null) : undefined,
      published: targetEntry.published ?? null,
      updated: targetEntry.updated ?? null,
      authors: authorNames,
      journalReference: targetEntry.journalRef ?? null,
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
