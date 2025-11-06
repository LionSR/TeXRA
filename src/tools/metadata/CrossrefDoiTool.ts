// Third-party imports
import { Temporal } from '@js-temporal/polyfill';
import { getWork, type PartialDate } from 'crossref-ts';
import { parse as parseDoi } from 'doi-ts';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { isNone } from 'fp-ts/Option';
import type { Fetch } from 'fetch-fp-ts';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';

const CrossrefDoiInputSchema = z.strictObject({
  doi: z.string(),
});

export type CrossrefDoiInput = z.infer<typeof CrossrefDoiInputSchema>;

const formatPartialDate = (value?: PartialDate | null): string | null => {
  if (!value) {
    return null;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (
    value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainYearMonth
  ) {
    return value.toString();
  }
  return null;
};

export class CrossrefDoiTool extends defineTool({
  name: 'crossref_doi',
  description: 'Look up detailed metadata for a DOI using Crossref.',
  schema: CrossrefDoiInputSchema,
}) {
  protected async execute(input: CrossrefDoiInput) {
    const trimmedDoi = input.doi.trim();
    const parsed = parseDoi(trimmedDoi);
    if (isNone(parsed)) {
      throw new ToolError('Invalid DOI string.');
    }

    const fetchAdapter: Fetch = ((url: string, init: RequestInit) => {
      return fetch(url, init);
    }) as unknown as Fetch;
    const workResult = await pipe(getWork(parsed.value), (reader) =>
      reader({ fetch: fetchAdapter }),
    )();
    if (E.isLeft(workResult)) {
      const reason = workResult.left;
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new ToolError(`Crossref lookup failed: ${message}`);
    }

    const work = workResult.right;
    const authors = work.author.map((author) =>
      'name' in author
        ? author.name
        : [author.given, author.family].filter(Boolean).join(' ').trim(),
    );
    const licenses = work.license.map((license) => ({
      url: license.URL.href,
      start: formatPartialDate(license.start),
    }));

    const metadata = {
      doi: work.DOI,
      title: work.title[0] ?? null,
      titles: work.title,
      publisher: work.publisher,
      type: work.type,
      abstract: work.abstract ?? null,
      description: work.description ?? null,
      created: formatPartialDate(work.created),
      published: formatPartialDate(work.published ?? null),
      url: work.resource.primary.URL.href,
      language: work.language ?? null,
      authors,
      licenses,
    };

    return toolResult({
      summary: `Retrieved Crossref metadata for DOI ${metadata.doi}`,
      output: JSON.stringify(metadata, null, 2),
    });
  }
}
