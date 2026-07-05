// Third-party imports
import { type Work } from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireNonEmptyString, wrapApiCall } from '@tools/utils';
import { defineTool } from '@tools/core/define';

// Local file imports
import { CROSSREF_CONSTANTS, crossrefClient } from './constants';
import { rateLimitedRequest } from './rateLimiter';

const CrossrefDoiInputSchema = z.strictObject({
  doi: z.string().describe('DOI to look up, with or without a DOI URL prefix.'),
});

export type CrossrefDoiInput = z.infer<typeof CrossrefDoiInputSchema>;

export class CrossrefDoiTool extends defineTool({
  name: 'crossref_doi',
  parallelSafe: true,
  description: 'Look up detailed metadata for a DOI using Crossref.',
  schema: CrossrefDoiInputSchema,
}) {
  protected async execute(input: CrossrefDoiInput): Promise<ToolResult> {
    const trimmedDoi = requireNonEmptyString(input.doi, 'DOI');

    const response = await wrapApiCall(
      () =>
        rateLimitedRequest(
          'crossref',
          CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
          'Crossref DOI lookup',
          () => crossrefClient.work(trimmedDoi),
        ),
      'Crossref lookup failed',
    );

    if (!response.ok || !response.content?.message) {
      throw new ToolError('Crossref response did not include metadata.');
    }

    const work: Work = response.content.message;

    const metadata = {
      doi: work.DOI,
      title: work.title?.[0] ?? null,
      titles: work.title ?? [],
      publisher: work.publisher,
      type: work.type,
      abstract: work.abstract ?? null,
      description: null, // Not in library type
      created: work.created,
      published: work.published ?? null,
      url: work.resource?.primary?.URL ?? null,
      language: work.language ?? null,
      authors: work.author ?? [],
      licenses: work.license ?? [],
    };

    return {
      status: 'executed',
      summary: `Retrieved: DOI ${metadata.doi}`,
      output: JSON.stringify(metadata, null, 2),
    };
  }
}
