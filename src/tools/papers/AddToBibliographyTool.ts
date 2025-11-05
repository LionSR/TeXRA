import { z } from 'zod';
import { Cite } from 'citation-js';
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AddToBibliography';
logger.initialize(CHANNEL);

export class AddToBibliographyTool extends defineTool({
  name: 'add_to_bibliography',
  description:
    'Fetch paper metadata from DOI or arXiv ID and add to bibliography. Automatically generates BibTeX entry.',
  schema: z.strictObject({
    identifier: z.string().min(1).describe('DOI, arXiv ID, or URL'),
    bibFilePath: z.string().optional().describe('Path to .bib file'),
    citationKey: z.string().optional().describe('Custom citation key'),
    overwrite: z.boolean().optional().describe('Replace existing entry'),
  }),
}) {
  protected async execute(input: z.infer<typeof this.schema>) {
    const { identifier, citationKey, overwrite = false } = input;
    const bibPath = input.bibFilePath || getConfig('texra.bibliography.centralBibFile', 'references.bib');

    logger.info(CHANNEL, `Adding to ${bibPath}: ${identifier}`);

    // Fetch new entry
    const newCitation = await Cite.async(identifier);
    const newData = newCitation.data[0];
    if (!newData) {
      throw new ToolError(`No metadata found for: ${identifier}`);
    }

    // Generate citation key
    const key = citationKey || this.generateKey(newData);
    newData.id = key;

    // Load existing bibliography
    let existingCitation = new Cite([]);
    if (await WorkspaceFS.exists(bibPath)) {
      const bibContent = await WorkspaceFS.read(bibPath);
      if (bibContent.trim()) {
        existingCitation = new Cite(bibContent);
      }
    }

    // Check for duplicates
    const existingEntry = existingCitation.data.find(entry => entry.id === key);
    if (existingEntry && !overwrite) {
      return toolResult({
        summary: `Entry "${key}" already exists`,
        output: formatToolOutput('Duplicate Entry', `Use overwrite: true to replace it.`),
      });
    }

    // Add or replace entry
    if (existingEntry) {
      existingCitation.data = existingCitation.data.filter(e => e.id !== key);
    }
    existingCitation.add(newData);

    // Save updated bibliography
    const updatedBibtex = existingCitation.format('bibtex');
    await WorkspaceFS.write(bibPath, updatedBibtex);

    // Format output
    const title = newData.title || 'Unknown';
    const authors = newData.author?.map((a: any) => `${a.given || ''} ${a.family || ''}`).join(', ') || 'Unknown';
    const year = newData.issued?.['date-parts']?.[0]?.[0] || 'Unknown';

    const output = formatToolOutput('Added to Bibliography', [
      `**Key:** \`${key}\``,
      `**Title:** ${title}`,
      `**Authors:** ${authors}`,
      `**Year:** ${year}`,
      `**File:** ${bibPath}`,
    ].join('\n'));

    return toolResult({
      summary: `Added "${key}" to ${bibPath}`,
      output,
    });
  }

  private generateKey(data: any): string {
    const author = data.author?.[0]?.family || 'unknown';
    const year = data.issued?.['date-parts']?.[0]?.[0] || '0000';
    const title = data.title || 'untitled';

    // Find first word with 4+ letters
    const words = title.split(' ');
    const firstWord = words.find((w: string) => w.length > 3) || words[0] || 'paper';

    // Clean to alphanumeric only
    const cleanAuthor = author.toLowerCase().split('').filter((c: string) => c >= 'a' && c <= 'z').join('');
    const cleanWord = firstWord.toLowerCase().split('').filter((c: string) => c >= 'a' && c <= 'z').join('');

    return `${cleanAuthor}${year}${cleanWord}`;
  }
}
