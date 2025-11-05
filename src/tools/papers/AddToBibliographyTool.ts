// Third-party imports
import { z } from 'zod';
import { Cite } from 'citation-js';
import * as bibtexParser from '@retorquere/bibtex-parser';
import * as arxivIdentifiers from 'identifiers-arxiv';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'AddToBibliography';
logger.initialize(CHANNEL);

const AddToBibliographyInputSchema = z.strictObject({
  identifier: z
    .string()
    .min(1, 'Identifier is required.')
    .describe(
      'Paper identifier: DOI (10.xxx), arXiv ID (2301.12345), or paper title',
    ),
  bibFilePath: z
    .string()
    .optional()
    .describe(
      'Path to .bib file (relative to workspace). If not provided, uses configured central bibliography file.',
    ),
  citationKey: z
    .string()
    .optional()
    .describe(
      'Custom citation key. If not provided, generates automatically (e.g., smith2023attention)',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe('Overwrite existing entry with same key (default: false)'),
});

export type AddToBibliographyInput = z.infer<
  typeof AddToBibliographyInputSchema
>;

interface ParsedBibtexEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
}

export class AddToBibliographyTool extends defineTool({
  name: 'add_to_bibliography',
  description:
    'Automatically fetch paper metadata and add BibTeX entry to bibliography file. Supports DOI, arXiv ID, or paper title. Handles deduplication.',
  schema: AddToBibliographyInputSchema,
}) {
  private detectIdentifierType(
    identifier: string,
  ): 'doi' | 'arxiv' | 'title' | 'unknown' {
    // Check for DOI
    if (identifier.startsWith('10.')) {
      return 'doi';
    }

    // Check for arXiv ID
    const extractedIds = arxivIdentifiers.extract(identifier);
    if (extractedIds.length > 0) {
      return 'arxiv';
    }

    // Check if it looks like a URL
    if (
      identifier.startsWith('http://') ||
      identifier.startsWith('https://')
    ) {
      // Try to extract DOI or arXiv from URL
      const doiMatch = identifier.match(/10\.\d{4,}\/[^\s]+/);
      if (doiMatch) {
        return 'doi';
      }

      const arxivMatch = identifier.match(/arxiv\.org\/abs\/([^\s]+)/);
      if (arxivMatch) {
        return 'arxiv';
      }
    }

    // Otherwise assume it's a title (for search)
    return 'title';
  }

  private async fetchMetadata(
    identifier: string,
    type: 'doi' | 'arxiv' | 'title',
  ): Promise<string> {
    logger.debug(
      CHANNEL,
      `Fetching metadata for ${type}: ${identifier}`,
    );

    try {
      if (type === 'doi') {
        // Extract DOI from URL if needed
        const doiMatch = identifier.match(/10\.\d{4,}\/[^\s]+/);
        const doi = doiMatch ? doiMatch[0] : identifier;

        const citation = await Cite.async(doi);
        return citation.format('bibtex');
      } else if (type === 'arxiv') {
        // Extract arXiv ID from URL if needed
        const arxivMatch = identifier.match(/arxiv\.org\/abs\/([^\s]+)/);
        const arxivId = arxivMatch ? arxivMatch[1] : identifier;

        const citation = await Cite.async(
          `https://arxiv.org/abs/${arxivId}`,
        );
        return citation.format('bibtex');
      } else {
        // For titles, we can't directly fetch - throw error
        throw new ToolError(
          'Title-based search not yet supported. Please provide a DOI or arXiv ID.',
        );
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      throw new ToolError(
        `Failed to fetch metadata for "${identifier}": ${errorMessage}`,
      );
    }
  }

  private parseBibtex(bibtexString: string): ParsedBibtexEntry {
    try {
      const parsed = bibtexParser.parse(bibtexString, {
        verbatimFields: ['abstract', 'url', 'file'],
      });

      if (!parsed.entries || parsed.entries.length === 0) {
        throw new Error('No BibTeX entries found in string');
      }

      const entry = parsed.entries[0];
      const fields: Record<string, string> = {};

      for (const [key, value] of Object.entries(entry.fields)) {
        fields[key] = String(value);
      }

      return {
        key: entry.key || 'unknown',
        type: entry.type || 'misc',
        fields,
      };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to parse BibTeX: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ToolError(`Failed to parse BibTeX entry`);
    }
  }

  private generateCitationKey(
    entry: ParsedBibtexEntry,
    customKey?: string,
  ): string {
    if (customKey) {
      // Sanitize custom key
      return customKey.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    // Auto-generate: firstauthor + year + firsttitleword
    const author =
      entry.fields.author || entry.fields.editor || 'unknown';
    const year =
      entry.fields.year || entry.fields.date?.split('-')[0] || '0000';
    const title = entry.fields.title || 'untitled';

    // Extract first author's last name
    const firstAuthorMatch = author.match(/([a-zA-Z]+)(?:,|\s+and\s+|$)/i);
    const firstAuthor = firstAuthorMatch
      ? firstAuthorMatch[1].toLowerCase()
      : 'unknown';

    // Extract first significant word from title
    const titleWords = title
      .replace(/[{}]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const firstTitleWord =
      titleWords[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'paper';

    return `${firstAuthor}${year}${firstTitleWord}`;
  }

  private formatBibtexEntry(
    key: string,
    type: string,
    fields: Record<string, string>,
  ): string {
    let bibtex = `@${type}{${key},\n`;

    // Order of fields for better readability
    const fieldOrder = [
      'author',
      'title',
      'year',
      'journal',
      'booktitle',
      'volume',
      'number',
      'pages',
      'publisher',
      'doi',
      'eprint',
      'archivePrefix',
      'primaryClass',
      'url',
      'abstract',
    ];

    const addedFields = new Set<string>();

    // Add fields in preferred order
    for (const field of fieldOrder) {
      if (fields[field]) {
        bibtex += `  ${field} = {${fields[field]}},\n`;
        addedFields.add(field);
      }
    }

    // Add remaining fields
    for (const [field, value] of Object.entries(fields)) {
      if (!addedFields.has(field)) {
        bibtex += `  ${field} = {${value}},\n`;
      }
    }

    // Remove trailing comma and close
    bibtex = bibtex.replace(/,\n$/, '\n');
    bibtex += '}\n';

    return bibtex;
  }

  private async readBibFile(bibPath: string): Promise<string> {
    if (await WorkspaceFS.exists(bibPath)) {
      return await WorkspaceFS.read(bibPath);
    }
    logger.debug(CHANNEL, `Bibliography file not found, will create: ${bibPath}`);
    return '';
  }

  private async writeBibFile(
    bibPath: string,
    content: string,
  ): Promise<void> {
    await WorkspaceFS.write(bibPath, content);
    logger.debug(CHANNEL, `Updated bibliography file: ${bibPath}`);
  }

  private checkDuplicate(
    existingBib: string,
    newKey: string,
  ): boolean {
    // Simple check: look for @type{newKey, pattern
    const keyPattern = new RegExp(`@\\w+\\{${newKey},`, 'i');
    return keyPattern.test(existingBib);
  }

  protected async execute(
    input: AddToBibliographyInput,
  ): Promise<ToolResult> {
    const { identifier, bibFilePath, citationKey, overwrite = false } =
      input;

    // Determine .bib file path
    const centralBibFile = getConfig<string>(
      'texra.bibliography.centralBibFile',
      'references.bib',
    );
    const targetBibPath = bibFilePath || centralBibFile;

    logger.info(
      CHANNEL,
      `Adding entry to bibliography: ${targetBibPath}`,
    );

    // Detect identifier type
    const idType = this.detectIdentifierType(identifier);
    if (idType === 'unknown') {
      throw new ToolError(
        `Could not determine identifier type for: "${identifier}". Please provide a DOI (10.xxx) or arXiv ID (xxxx.xxxxx).`,
      );
    }

    // Fetch metadata
    const bibtexString = await this.fetchMetadata(identifier, idType);
    const parsedEntry = this.parseBibtex(bibtexString);

    // Generate citation key
    const finalKey = this.generateCitationKey(parsedEntry, citationKey);

    // Read existing .bib file
    const existingBib = await this.readBibFile(targetBibPath);

    // Check for duplicates
    const isDuplicate = this.checkDuplicate(existingBib, finalKey);
    if (isDuplicate && !overwrite) {
      return toolResult({
        summary: `Entry with key "${finalKey}" already exists in ${targetBibPath}`,
        output: formatToolOutput(
          'Duplicate Entry',
          `Citation key "${finalKey}" already exists. Use overwrite: true to replace it.`,
        ),
      });
    }

    // Format new entry
    const formattedEntry = this.formatBibtexEntry(
      finalKey,
      parsedEntry.type,
      parsedEntry.fields,
    );

    // Update .bib file
    let updatedBib: string;
    if (isDuplicate && overwrite) {
      // Remove old entry and add new one
      const entryPattern = new RegExp(
        `@\\w+\\{${finalKey},.*?\\n\\}`,
        'is',
      );
      updatedBib = existingBib.replace(entryPattern, '').trim();
      updatedBib += '\n\n' + formattedEntry;
    } else {
      // Append new entry
      updatedBib = existingBib.trim();
      if (updatedBib) {
        updatedBib += '\n\n';
      }
      updatedBib += formattedEntry;
    }

    await this.writeBibFile(targetBibPath, updatedBib);

    // Build output
    const outputLines: string[] = [];
    outputLines.push(`**Citation Key:** \`${finalKey}\``);
    outputLines.push(`**Entry Type:** @${parsedEntry.type}`);
    outputLines.push(
      `**Title:** ${parsedEntry.fields.title || 'Unknown'}`,
    );
    outputLines.push(
      `**Authors:** ${parsedEntry.fields.author || 'Unknown'}`,
    );
    outputLines.push(
      `**Year:** ${parsedEntry.fields.year || 'Unknown'}`,
    );
    outputLines.push(
      `**File:** ${targetBibPath}`,
    );
    outputLines.push(
      `**Action:** ${isDuplicate && overwrite ? 'Updated' : 'Added'}`,
    );
    outputLines.push(`\n**BibTeX Entry:**\n\`\`\`bibtex\n${formattedEntry}\n\`\`\``);

    const output = formatToolOutput(
      `Added to Bibliography: ${finalKey}`,
      outputLines.join('\n'),
    );

    const action = isDuplicate && overwrite ? 'Updated' : 'Added';
    return toolResult({
      summary: `${action} citation "${finalKey}" to ${targetBibPath}`,
      output,
    });
  }
}
