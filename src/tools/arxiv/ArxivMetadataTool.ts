// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import {
  type ArxivPaperMetadata,
  createArxivClient,
  extractBasePaperMetadata,
  normaliseArxivIdentifier,
} from '@tools/latex/arxivShared';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { waitForRateLimit } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';
import { arxivProcessor } from '@latex/arxivProcessor';

const ArxivMetadataInputSchema = z.strictObject({
  id: z.string(),
  includeAbstract: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
  maxAuthors: z.int().positive().max(ARXIV_CONSTANTS.MAX_AUTHORS).nullish(),
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
      // Respect arXiv API rate limits
      await waitForRateLimit('arxiv', ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS);
      // Use arxiv-client's ids() method for direct ID lookup
      entries = await createArxivClient().ids([requestId]).execute();
    } catch (error) {
      throw new ToolError(
        `Failed to query arXiv API: ${toErrorMessage(error)}`,
      );
    }

    if (!entries || entries.length === 0) {
      throw new ToolError(`No metadata found for arXiv ID ${requestId}`);
    }

    const targetEntry = entries[0];
    const base = extractBasePaperMetadata(
      targetEntry,
      input.maxAuthors ?? undefined,
    );
    const { includeAbstract } = input;

    const metadata: ArxivPaperMetadata = {
      ...base,
      id: base.id ?? requestId,
      journalReference: targetEntry.journalRef ?? null,
      comment: targetEntry.comment ?? null,
      links: targetEntry.links ?? null,
      ...(includeAbstract && { abstract: targetEntry.summary ?? null }),
    };

    return {
      summary: `Retrieved: ${metadata.id}`,
      output: JSON.stringify(metadata, null, 2),
    };
  }
}
