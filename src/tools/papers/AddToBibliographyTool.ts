// Third-party imports
import { z } from 'zod';
import { Cite } from 'citation-js';

// Local imports
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AddToBibliography';
logger.initialize(CHANNEL);

const AddToBibliographyInputSchema = z.strictObject({
  identifier: z
    .string()
    .min(1)
    .describe('DOI (10.xxx), arXiv ID (2301.12345), or URL'),
  bibFilePath: z
    .string()
    .optional()
    .describe('Path to .bib file (defaults to configured central file)'),
  citationKey: z
    .string()
    .optional()
    .describe('Custom citation key (auto-generated if not provided)'),
  overwrite: z
    .boolean()
    .optional()
    .describe('Replace existing entry (default: false)'),
});

export type AddToBibliographyInput = z.infer<typeof AddToBibliographyInputSchema>;

export class AddToBibliographyTool extends defineTool({
  name: 'add_to_bibliography',
  description:
    'Fetch paper metadata from DOI or arXiv ID and add to bibliography. Automatically generates BibTeX entry.',
  schema: AddToBibliographyInputSchema,
}) {
  private async fetchBibtex(identifier: string): Promise<{ bibtex: string; data: any }> {
    try {
      // citation-js handles DOIs, arXiv IDs, and URLs automatically
      const citation = await Cite.async(identifier);
      const bibtex = citation.format('bibtex');
      const data = citation.data[0];

      if (!data) {
        throw new Error('No metadata found');
      }

      return { bibtex, data };
    } catch (err) {
      throw new ToolError(
        `Failed to fetch "${identifier}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private generateKey(data: any, customKey?: string): string {
    if (customKey) {
      return customKey.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    // Extract components for auto-generated key
    const author = data.author?.[0]?.family || 'unknown';
    const year = data.issued?.['date-parts']?.[0]?.[0] || '0000';
    const title = data.title || 'untitled';
    const firstWord = title.split(/\s+/).find((w: string) => w.length > 3) || 'paper';

    return `${author.toLowerCase()}${year}${firstWord.toLowerCase().replace(/[^a-z]/g, '')}`;
  }

  private keyExists(bibContent: string, key: string): boolean {
    return new RegExp(`@\\w+\\{${key},`, 'i').test(bibContent);
  }

  private replaceBibtexEntry(bibContent: string, key: string, newEntry: string): string {
    const pattern = new RegExp(`@\\w+\\{${key},.*?\\n\\}\\s*`, 'is');
    return bibContent.replace(pattern, '') + '\n' + newEntry;
  }

  protected async execute(input: AddToBibliographyInput): Promise<ToolResult> {
    const { identifier, citationKey, overwrite = false } = input;

    const centralFile = getConfig('texra.bibliography.centralBibFile', 'references.bib');
    const bibPath = input.bibFilePath || centralFile;

    logger.info(CHANNEL, `Adding to ${bibPath}: ${identifier}`);

    // Fetch metadata and generate BibTeX
    const { bibtex, data } = await this.fetchBibtex(identifier);
    const key = this.generateKey(data, citationKey);

    // Read existing .bib file (or create new)
    let bibContent = '';
    if (await WorkspaceFS.exists(bibPath)) {
      bibContent = await WorkspaceFS.read(bibPath);
    }

    // Check for duplicates
    const exists = this.keyExists(bibContent, key);
    if (exists && !overwrite) {
      return toolResult({
        summary: `Entry "${key}" already exists`,
        output: formatToolOutput(
          'Duplicate Entry',
          `Citation key "${key}" already exists. Use overwrite: true to replace.`
        ),
      });
    }

    // Replace key in BibTeX entry
    const updatedEntry = bibtex.replace(/@\w+\{[^,]+,/, `@${data.type || 'misc'}{${key},`);

    // Update .bib file
    const newContent = exists
      ? this.replaceBibtexEntry(bibContent, key, updatedEntry)
      : bibContent.trim() + (bibContent ? '\n\n' : '') + updatedEntry;

    await WorkspaceFS.write(bibPath, newContent);

    // Format output
    const title = data.title || 'Unknown';
    const authors = data.author?.map((a: any) => `${a.given} ${a.family}`).join(', ') || 'Unknown';
    const year = data.issued?.['date-parts']?.[0]?.[0] || 'Unknown';

    const output = formatToolOutput(
      `Added to Bibliography`,
      [
        `**Key:** \`${key}\``,
        `**Title:** ${title}`,
        `**Authors:** ${authors}`,
        `**Year:** ${year}`,
        `**File:** ${bibPath}`,
        '',
        '**BibTeX Entry:**',
        '```bibtex',
        updatedEntry,
        '```',
      ].join('\n')
    );

    return toolResult({
      summary: `Added "${key}" to ${bibPath}`,
      output,
    });
  }
}
