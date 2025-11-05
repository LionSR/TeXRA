// Third-party imports
import Cite from 'citation-js';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';
import { formatToolOutput } from '../utils';

const DoiMetadataInputSchema = z.strictObject({
  doi: z.string(),
  bibliographyStyle: z.string().optional(),
  includeBibTeX: z.boolean().optional(),
});

export type DoiMetadataInput = z.infer<typeof DoiMetadataInputSchema>;

type CiteRecord = (typeof Cite)['prototype']['data'][number];
type CiteName = NonNullable<CiteRecord['author']>[number];

const normalizeDoi = (value: string): string =>
  value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();

const formatName = (name: CiteName | undefined): string | undefined => {
  if (!name) {
    return undefined;
  }

  if (typeof name.literal === 'string' && name.literal.trim().length > 0) {
    return name.literal.trim();
  }

  const parts = [name.given, name.family].filter(
    (component): component is string =>
      Boolean(component && component.trim().length > 0),
  );

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(' ');
};

const formatDate = (record: CiteRecord): string | undefined => {
  const issued =
    record.issued?.['date-parts'] ?? record.published?.['date-parts'];
  if (!issued || issued.length === 0 || issued[0].length === 0) {
    return undefined;
  }

  const [year, month, day] = issued[0];
  const components = [year, month, day]
    .map((component) =>
      typeof component === 'number' || typeof component === 'string'
        ? String(component)
        : undefined,
    )
    .filter((component): component is string => Boolean(component));

  if (components.length === 0) {
    return undefined;
  }

  return components.join('-');
};

const getContainerTitle = (record: CiteRecord): string | undefined => {
  const container = record['container-title'];
  if (!container) {
    return undefined;
  }

  if (Array.isArray(container)) {
    return container[0];
  }

  return container;
};

const buildOutput = (
  record: CiteRecord,
  bibliography?: string,
  bibtex?: string,
): string => {
  const authors = (record.author ?? [])
    .map((entry) => formatName(entry))
    .filter((name): name is string => Boolean(name));

  const basicInfo: string[] = [
    `**Title:** ${record.title ?? 'Untitled work'}`,
    record.DOI ? `**DOI:** ${record.DOI}` : undefined,
    record.type ? `**Type:** ${record.type}` : undefined,
    getContainerTitle(record)
      ? `**Container:** ${getContainerTitle(record)}`
      : undefined,
    record.publisher ? `**Publisher:** ${record.publisher}` : undefined,
    formatDate(record)
      ? `**Publication date:** ${formatDate(record)}`
      : undefined,
    record.URL ? `**URL:** ${record.URL}` : undefined,
  ].filter((line): line is string => Boolean(line));

  const sections: string[] = [
    formatToolOutput('DOI metadata', basicInfo.join('\n')),
  ];

  if (authors.length > 0) {
    sections.push(
      formatToolOutput(
        'Authors',
        authors.map((name, index) => `${index + 1}. ${name}`).join('\n'),
      ),
    );
  }

  if (
    typeof record.abstract === 'string' &&
    record.abstract.trim().length > 0
  ) {
    sections.push(formatToolOutput('Abstract', record.abstract.trim()));
  }

  if (bibliography) {
    sections.push(formatToolOutput('Formatted citation', bibliography));
  }

  if (bibtex) {
    sections.push(
      formatToolOutput('BibTeX', ['```bibtex', bibtex, '```'].join('\n')),
    );
  }

  return sections.join('\n\n');
};

export class DoiMetadataTool extends defineTool({
  name: 'get_doi_metadata',
  description:
    'Fetch metadata for a DOI using citation-js, including authors, publication details, and formatted citations.',
  schema: DoiMetadataInputSchema,
}) {
  protected async execute(input: DoiMetadataInput) {
    const doi = normalizeDoi(input.doi);
    if (!doi) {
      throw new ToolError('Provide a DOI to look up.');
    }

    let cite: Cite;
    try {
      cite = await Cite.async(doi);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to resolve DOI ${doi}: ${message}`);
    }

    const record = cite.data?.[0];
    if (!record) {
      throw new ToolError(`No metadata was returned for DOI ${doi}.`);
    }

    let bibliography: string | undefined;
    if (input.bibliographyStyle) {
      try {
        bibliography = cite.format('bibliography', {
          format: 'text',
          template: input.bibliographyStyle,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Failed to format bibliography: ${message}`);
      }
    }

    let bibtex: string | undefined;
    if (input.includeBibTeX ?? true) {
      try {
        bibtex = cite.format('bibtex');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Failed to generate BibTeX output: ${message}`);
      }
    }

    const summaryTitle = record.title ?? record.DOI ?? doi;
    const summary = `Retrieved metadata for DOI ${doi}: ${summaryTitle}`;
    const output = buildOutput(record, bibliography, bibtex);

    return toolResult({
      summary,
      output,
    });
  }
}
