// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';
import { ArxivProcessor } from '@latex/arxivProcessor';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import {
  type ArxivPaperMetadata,
  createArxivClient,
  extractBasePaperMetadata,
} from '@tools/latex/arxivShared';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { rateLimitedRequest } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';
import { toErrorMessage } from '@utils/errors/errorMessage';

const ArxivMetadataInputSchema = z.strictObject({
  id: z.string().describe('arXiv identifier or URL for the paper.'),
  includeAbstract: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true)
    .describe('Include the paper abstract in the metadata response.'),
  maxAuthors: z
    .int()
    .positive()
    .max(ARXIV_CONSTANTS.MAX_AUTHORS)
    .nullish()
    .describe('Maximum number of authors to include before truncating.'),
});

export type ArxivMetadataInput = z.infer<typeof ArxivMetadataInputSchema>;

export class ArxivMetadataTool extends defineTool({
  name: 'arxiv_metadata',
  parallelSafe: true,
  description: 'Fetch bibliographic metadata for an arXiv paper.',
  schema: ArxivMetadataInputSchema,
}) {
  protected async execute(input: ArxivMetadataInput): Promise<ToolResult> {
    const rawId = input.id.trim();
    const validationError = ArxivProcessor.validateId(rawId);
    if (validationError) {
      throw new ToolError(validationError);
    }

    const requestId = normaliseArxivIdentifier(rawId);

    let entries;
    try {
      // Use arxiv-client's ids() method for direct ID lookup.
      entries = await rateLimitedRequest(
        'arxiv',
        ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS,
        'arXiv metadata lookup',
        () => createArxivClient().ids([requestId]).execute(),
      );
    } catch (error) {
      throw new ToolError(
        `Failed to query arXiv API: ${toErrorMessage(error)}`,
      );
    }

    if (!entries?.length) {
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
      status: 'executed',
      summary: `Retrieved: ${metadata.id}`,
      output: JSON.stringify(metadata, null, 2),
    };
  }
}
