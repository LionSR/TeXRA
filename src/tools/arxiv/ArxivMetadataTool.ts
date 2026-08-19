// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';
import { ArxivProcessor } from '@latex/arxivProcessor';
import { ToolError, type ToolResult } from '@shared/schemas';
import {
  type ArxivPaperMetadata,
  createArxivClient,
  extractBasePaperMetadata,
} from '@tools/arxiv/arxivShared';
import { ARXIV_CONSTANTS } from '@tools/citation/constants';
import { rateLimitedApiCall } from '@tools/citation/rateLimiter';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';

const ArxivMetadataInputSchema = z.strictObject({
  id: z.string().describe('arXiv identifier or URL for the paper.'),
  includeAbstract: nullishWithDefault(z.boolean(), true).describe(
    'Include the paper abstract in the metadata response.',
  ),
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

    // validateId above guarantees extraction succeeds, so the null fallback is
    // unreachable and just satisfies the type.
    const requestId = normaliseArxivIdentifier(rawId) ?? rawId;

    // Use arxiv-client's ids() method for direct ID lookup.
    const entries = await rateLimitedApiCall(
      'arxiv',
      ARXIV_CONSTANTS.RATE_LIMIT_DELAY_MS,
      'arXiv metadata lookup',
      'Failed to query arXiv API',
      () => createArxivClient().ids([requestId]).execute(),
    );

    if (!entries?.length) {
      throw new ToolError(`No metadata found for arXiv ID ${requestId}`);
    }

    const targetEntry = entries[0];
    const base = extractBasePaperMetadata(
      targetEntry,
      input.maxAuthors ?? undefined,
    );

    const metadata: ArxivPaperMetadata = {
      ...base,
      id: base.id ?? requestId,
      journalReference: targetEntry.journalRef ?? null,
      comment: targetEntry.comment ?? null,
      links: targetEntry.links ?? null,
      ...(input.includeAbstract && { abstract: targetEntry.summary ?? null }),
    };

    return executed(
      JSON.stringify(metadata, null, 2),
      `Retrieved: ${metadata.id}`,
    );
  }
}
