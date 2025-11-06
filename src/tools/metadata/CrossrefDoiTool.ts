// Third-party imports
import crossref from 'crossref';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const CrossrefDoiInputSchema = z.strictObject({
  doi: z.string(),
});

export type CrossrefDoiInput = z.infer<typeof CrossrefDoiInputSchema>;

type CrossrefWorkCallback = (
  error: Error | null,
  message?: Record<string, unknown>,
) => void;

const fetchWork = (doi: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    (
      crossref.work as unknown as (
        doiValue: string,
        cb: CrossrefWorkCallback,
      ) => void
    )(doi, (error, message) => {
      if (error) {
        reject(error);
        return;
      }
      if (!message || typeof message !== 'object') {
        reject(new Error('Crossref response did not include metadata.'));
        return;
      }
      resolve(message);
    });
  });

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
      work = await fetchWork(trimmedDoi);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Crossref lookup failed: ${message}`);
    }

    const titleValue = work.title;
    const resolvedTitle = Array.isArray(titleValue)
      ? (titleValue.find((entry) => typeof entry === 'string') ?? null)
      : typeof titleValue === 'string'
        ? titleValue
        : null;

    const metadata = {
      doi: typeof work.DOI === 'string' ? work.DOI : trimmedDoi,
      title: resolvedTitle,
      titles: Array.isArray(titleValue)
        ? titleValue
        : resolvedTitle
          ? [resolvedTitle]
          : [],
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
