// Standard library imports
import axios from 'axios';

// Third-party imports
import { z } from 'zod';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import * as arxivIdentifiers from 'identifiers-arxiv';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';

const parseXml = promisify(parseString);

const ArxivMetadataInputSchema = z.strictObject({
  query: z
    .string()
    .optional()
    .describe('Search query for arXiv papers'),
  arxivId: z
    .string()
    .optional()
    .describe('Specific arXiv ID (e.g., "2301.12345" or "2301.12345v1")'),
  maxResults: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of results to return (default: 5, max: 50)'),
  includeAbstract: z
    .boolean()
    .optional()
    .describe('Include full abstract in output (default: true)'),
  format: z
    .enum(['bibtex', 'json', 'summary'])
    .optional()
    .describe('Output format (default: summary)'),
});

export type ArxivMetadataInput = z.infer<typeof ArxivMetadataInputSchema>;

interface ArxivPaper {
  id: string;
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  htmlUrl: string;
  doi?: string;
  journalRef?: string;
  comment?: string;
}

export class ArxivMetadataTool extends defineTool({
  name: 'arxiv_metadata',
  description:
    'Search arXiv for papers or retrieve metadata for a specific arXiv ID. Returns paper details including title, authors, abstract, and URLs.',
  schema: ArxivMetadataInputSchema,
}) {
  private validateArxivId(id: string): boolean {
    const extractedIds = arxivIdentifiers.extract(id);
    return extractedIds.length > 0 && extractedIds.includes(id);
  }

  private async fetchArxivData(
    arxivId?: string,
    query?: string,
    maxResults = 5,
  ): Promise<ArxivPaper[]> {
    let searchQuery = '';

    if (arxivId) {
      // Validate arXiv ID
      if (!this.validateArxivId(arxivId)) {
        throw new ToolError(
          `Invalid arXiv ID format: "${arxivId}". Please provide a valid arXiv ID like "2301.12345" or "2301.12345v1"`,
        );
      }
      searchQuery = `id_list=${arxivId}`;
    } else if (query) {
      searchQuery = `search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}&sortBy=relevance`;
    } else {
      throw new ToolError(
        'Either arxivId or query must be provided',
      );
    }

    const url = `http://export.arxiv.org/api/query?${searchQuery}`;

    try {
      const response = await axios.get(url, { timeout: 15000 });
      const parsed: any = await parseXml(response.data);

      const entries = parsed.feed.entry || [];
      if (!Array.isArray(entries)) {
        return entries ? [this.parseEntry(entries)] : [];
      }

      return entries.map((entry: any) => this.parseEntry(entry));
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      throw new ToolError(
        `Failed to fetch arXiv data: ${errorMessage}`,
      );
    }
  }

  private parseEntry(entry: any): ArxivPaper {
    const id = entry.id[0];
    const arxivId = id.split('/abs/')[1] || id;
    const title = entry.title[0].trim().replace(/\s+/g, ' ');
    const authors = entry.author.map((a: any) => a.name[0]);
    const abstract = entry.summary[0].trim();
    const published = entry.published[0];
    const updated = entry.updated[0];
    const categories = entry.category?.map((c: any) => c.$.term) || [];

    const pdfLink = entry.link?.find(
      (l: any) => l.$.type === 'application/pdf',
    );
    const pdfUrl = pdfLink?.$.href || '';
    const htmlUrl = entry.id[0];

    const doi = entry['arxiv:doi']?.[0];
    const journalRef = entry['arxiv:journal_ref']?.[0];
    const comment = entry['arxiv:comment']?.[0];

    return {
      id,
      arxivId,
      title,
      authors,
      abstract,
      published,
      updated,
      categories,
      pdfUrl,
      htmlUrl,
      doi,
      journalRef,
      comment,
    };
  }

  private generateBibtex(paper: ArxivPaper): string {
    const year = paper.published.split('-')[0];
    const firstAuthor = paper.authors[0]?.split(' ').pop()?.toLowerCase() || 'unknown';
    const titleWords = paper.title.split(' ');
    const firstTitleWord = titleWords[0]?.toLowerCase() || 'paper';
    const citationKey = `${firstAuthor}${year}${firstTitleWord}`;

    const authorsStr = paper.authors.join(' and ');
    const truncatedAbstract = paper.abstract.length > 500
      ? paper.abstract.substring(0, 500) + '...'
      : paper.abstract;

    let bibtex = `@misc{${citationKey},\n`;
    bibtex += `  title={${paper.title}},\n`;
    bibtex += `  author={${authorsStr}},\n`;
    bibtex += `  year={${year}},\n`;
    bibtex += `  eprint={${paper.arxivId}},\n`;
    bibtex += `  archivePrefix={arXiv},\n`;
    bibtex += `  primaryClass={${paper.categories[0] || 'cs.AI'}},\n`;
    bibtex += `  abstract={${truncatedAbstract}},\n`;
    bibtex += `  url={${paper.htmlUrl}}`;
    if (paper.doi) {
      bibtex += `,\n  doi={${paper.doi}}`;
    }
    if (paper.journalRef) {
      bibtex += `,\n  journal={${paper.journalRef}}`;
    }
    bibtex += '\n}';

    return bibtex;
  }

  private formatPaperSummary(paper: ArxivPaper, includeAbstract = true): string[] {
    const lines: string[] = [];
    lines.push(`**Title:** ${paper.title}`);
    lines.push(`**Authors:** ${paper.authors.join(', ')}`);
    lines.push(`**arXiv ID:** ${paper.arxivId}`);
    lines.push(`**Published:** ${paper.published.split('T')[0]}`);
    lines.push(`**Updated:** ${paper.updated.split('T')[0]}`);
    lines.push(`**Categories:** ${paper.categories.join(', ')}`);

    if (paper.doi) {
      lines.push(`**DOI:** ${paper.doi}`);
    }
    if (paper.journalRef) {
      lines.push(`**Journal Reference:** ${paper.journalRef}`);
    }
    if (paper.comment) {
      lines.push(`**Comment:** ${paper.comment}`);
    }

    lines.push(`**PDF:** ${paper.pdfUrl}`);
    lines.push(`**HTML:** ${paper.htmlUrl}`);

    if (includeAbstract) {
      const truncatedAbstract = paper.abstract.length > 500
        ? paper.abstract.substring(0, 500) + '...'
        : paper.abstract;
      lines.push(`\n**Abstract:**\n${truncatedAbstract}`);
    }

    return lines;
  }

  protected async execute(input: ArxivMetadataInput): Promise<ToolResult> {
    const {
      query,
      arxivId,
      maxResults = 5,
      includeAbstract = true,
      format = 'summary',
    } = input;

    const papers = await this.fetchArxivData(arxivId, query, maxResults);

    if (papers.length === 0) {
      const searchTerm = arxivId || query || 'unknown';
      return toolResult({
        summary: `No papers found for: ${searchTerm}`,
        output: formatToolOutput('arXiv Search Results', 'No papers found.'),
      });
    }

    const outputSections: string[] = [];

    for (let i = 0; i < papers.length; i++) {
      const paper = papers[i];

      if (format === 'bibtex') {
        const bibtex = this.generateBibtex(paper);
        outputSections.push(`\n### Paper ${i + 1}: ${paper.title}\n\n${bibtex}`);
      } else if (format === 'json') {
        outputSections.push(`\n### Paper ${i + 1}\n\n\`\`\`json\n${JSON.stringify(paper, null, 2)}\n\`\`\``);
      } else {
        // summary format
        const summary = this.formatPaperSummary(paper, includeAbstract);
        if (papers.length > 1) {
          outputSections.push(`\n### Paper ${i + 1}/${papers.length}\n\n${summary.join('\n')}`);
        } else {
          outputSections.push(summary.join('\n'));
        }
      }
    }

    const searchDescription = arxivId
      ? `arXiv ID: ${arxivId}`
      : `query: "${query}"`;

    const output = formatToolOutput(
      `arXiv Results for ${searchDescription}`,
      outputSections.join('\n\n---\n'),
    );

    return toolResult({
      summary: `Found ${papers.length} paper${papers.length === 1 ? '' : 's'} for ${searchDescription}`,
      output,
    });
  }
}
