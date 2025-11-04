// Third-party imports
import { z } from 'zod';
import { Cite } from 'citation-js';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';

const DoiLookupInputSchema = z.strictObject({
  doi: z
    .string()
    .min(1, 'DOI is required.')
    .describe('Digital Object Identifier (e.g., "10.1145/3394486.3403043")'),
  format: z
    .enum(['bibtex', 'json', 'apa', 'vancouver', 'harvard'])
    .optional()
    .describe('Output format for the citation (default: bibtex)'),
  includeAbstract: z
    .boolean()
    .optional()
    .describe('Include abstract in the output (default: true)'),
});

export type DoiLookupInput = z.infer<typeof DoiLookupInputSchema>;

export class DoiLookupTool extends defineTool({
  name: 'doi_lookup',
  description:
    'Retrieve metadata for an academic paper using its DOI. Returns citation information in various formats.',
  schema: DoiLookupInputSchema,
}) {
  protected async execute(input: DoiLookupInput): Promise<ToolResult> {
    const { doi, format = 'bibtex', includeAbstract = true } = input;

    // Validate DOI format (basic check)
    if (!doi.startsWith('10.')) {
      throw new ToolError(
        `Invalid DOI format: "${doi}". DOI should start with "10."`,
      );
    }

    try {
      // Fetch citation data using citation-js
      const citation = await Cite.async(doi);

      // Get the raw data
      const data = citation.data[0];

      if (!data) {
        throw new ToolError(`No data found for DOI: ${doi}`);
      }

      // Extract metadata
      const metadata = {
        doi: data.DOI || doi,
        title: data.title || 'Unknown title',
        authors:
          data.author?.map((a: any) => `${a.given} ${a.family}`).join(', ') ||
          'Unknown authors',
        year: data.issued?.['date-parts']?.[0]?.[0] || 'Unknown year',
        journal: data['container-title'] || 'Unknown venue',
        volume: data.volume,
        issue: data.issue,
        pages: data.page,
        publisher: data.publisher,
        abstract: includeAbstract ? data.abstract : undefined,
        url: data.URL || `https://doi.org/${doi}`,
        type: data.type,
      };

      // Generate formatted citation
      let formattedCitation: string;
      if (format === 'bibtex') {
        formattedCitation = citation.format('bibtex');
      } else if (format === 'json') {
        formattedCitation = JSON.stringify(data, null, 2);
      } else {
        // For other formats (apa, vancouver, harvard)
        formattedCitation = citation.format('bibliography', {
          format: 'text',
          template: format,
          lang: 'en-US',
        });
      }

      // Build output
      const outputLines: string[] = [];
      outputLines.push(`**Title:** ${metadata.title}`);
      outputLines.push(`**Authors:** ${metadata.authors}`);
      outputLines.push(`**Year:** ${metadata.year}`);
      outputLines.push(`**Journal/Conference:** ${metadata.journal}`);
      if (metadata.volume) {
        outputLines.push(`**Volume:** ${metadata.volume}`);
      }
      if (metadata.issue) {
        outputLines.push(`**Issue:** ${metadata.issue}`);
      }
      if (metadata.pages) {
        outputLines.push(`**Pages:** ${metadata.pages}`);
      }
      if (metadata.publisher) {
        outputLines.push(`**Publisher:** ${metadata.publisher}`);
      }
      outputLines.push(`**DOI:** ${metadata.doi}`);
      outputLines.push(`**URL:** ${metadata.url}`);

      if (includeAbstract && metadata.abstract) {
        const truncatedAbstract =
          metadata.abstract.length > 500
            ? metadata.abstract.substring(0, 500) + '...'
            : metadata.abstract;
        outputLines.push(`\n**Abstract:**\n${truncatedAbstract}`);
      }

      outputLines.push(`\n**Formatted Citation (${format}):**\n${formattedCitation}`);

      const output = formatToolOutput(
        `Paper metadata for DOI: ${doi}`,
        outputLines,
      );

      return toolResult({
        summary: `Retrieved metadata for DOI: ${doi}`,
        output,
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      throw new ToolError(
        `Failed to lookup DOI "${doi}": ${errorMessage}. Ensure the DOI is valid and accessible.`,
      );
    }
  }
}
