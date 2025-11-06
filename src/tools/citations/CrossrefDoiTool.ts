// Third-party imports
import { CrossrefClient } from '@jamesgopsill/crossref-client';
import { z } from 'zod';

// Local imports - metadata
import { CROSSREF_CONSTANTS } from './constants';
import { waitForRateLimit } from './rateLimiter';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const CrossrefDoiInputSchema = z.strictObject({
  doi: z.string(),
});

export type CrossrefDoiInput = z.infer<typeof CrossrefDoiInputSchema>;

const crossrefClient = new CrossrefClient();

/**
 * Type guard to safely access Crossref work metadata properties.
 * The library returns untyped objects, so we use this helper to access properties safely.
 */
function isWorkMetadata(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

    let work: Record<string, unknown>;
    try {
      // Respect Crossref API rate limits
      await waitForRateLimit(
        'crossref',
        CROSSREF_CONSTANTS.RATE_LIMIT_DELAY_MS,
      );
      const response = await crossrefClient.work(trimmedDoi);
      if (!response.ok || !response.content || !response.content.message) {
        throw new Error('Crossref response did not include metadata.');
      }
      const message = response.content.message;
      if (!isWorkMetadata(message)) {
        throw new Error('Crossref metadata payload was empty.');
      }
      work = message;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Crossref lookup failed: ${message}`);
    }

    const titleValue = work.title;
    const titles = Array.isArray(titleValue)
      ? titleValue.filter((entry): entry is string => typeof entry === 'string')
      : typeof titleValue === 'string'
        ? [titleValue]
        : [];
    const resolvedTitle = titles.length > 0 ? titles[0] : null;

    const metadata = {
      doi: typeof work.DOI === 'string' ? work.DOI : trimmedDoi,
      title: resolvedTitle,
      titles,
      publisher: typeof work.publisher === 'string' ? work.publisher : null,
      type: typeof work.type === 'string' ? work.type : null,
      abstract: typeof work.abstract === 'string' ? work.abstract : null,
      description:
        typeof work.description === 'string' ? work.description : null,
      created: work.created ?? null,
      published: work.published ?? null,
      url: typeof work.URL === 'string' ? work.URL : null,
      language: typeof work.language === 'string' ? work.language : null,
      authors: Array.isArray(work.author) ? work.author : [],
      licenses: Array.isArray(work.license) ? work.license : [],
    };

    return toolResult({
      summary: `Retrieved Crossref metadata for DOI ${metadata.doi}`,
      output: JSON.stringify(metadata, null, 2),
    });
  }
}
