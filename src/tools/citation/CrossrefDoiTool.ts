// Third-party imports
import { CrossrefClient, type Work } from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - metadata
import { toErrorMessage } from '@common/errors';
import { ToolError } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local file imports
import { CROSSREF_CONSTANTS } from './constants';
import { waitForRateLimit } from './rateLimiter';

const CrossrefDoiInputSchema = z.strictObject({
  doi: z.string(),
});

export type CrossrefDoiInput = z.infer<typeof CrossrefDoiInputSchema>;

const crossrefClient = new CrossrefClient();

export class CrossrefDoiTool extends defineTool({
  name: 'crossref_doi',
  description: 'Look up detailed metadata for a DOI using Crossref.',
  schema: CrossrefDoiInputSchema,
}) {
  protected async execute(input: CrossrefDoiInput) {
    const trimmedDoi = input.doi.trim();
    if (!trimmedDoi) {
      throw new ToolError('Invalid DOI string.');
    }

    let work: Work;
    try {
      // Respect Crossref API rate limits
      await waitForRateLimit(
        'crossref',
        CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
      );
      const response = await crossrefClient.work(trimmedDoi);
      if (!response.ok || !response.content?.message) {
        throw new Error('Crossref response did not include metadata.');
      }
      work = response.content.message;
    } catch (error) {
      throw new ToolError(`Crossref lookup failed: ${toErrorMessage(error)}`);
    }

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
      summary: `Retrieved Crossref metadata for DOI ${metadata.doi}`,
      output: JSON.stringify(metadata, null, 2),
    };
  }
}
