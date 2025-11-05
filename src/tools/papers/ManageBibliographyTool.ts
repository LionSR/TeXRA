// Third-party imports
import { z } from 'zod';
import * as bibtexParser from '@retorquere/bibtex-parser';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'ManageBibliography';
logger.initialize(CHANNEL);

const ManageBibliographyInputSchema = z.strictObject({
  bibFilePath: z
    .string()
    .optional()
    .describe(
      'Path to .bib file (relative to workspace). If not provided, uses configured central bibliography file.',
    ),
  action: z
    .enum(['validate', 'deduplicate', 'format', 'analyze', 'check_unused'])
    .describe(
      'Action to perform: validate (check for issues), deduplicate (remove duplicates), format (clean formatting), analyze (get statistics), check_unused (find unused entries compared to .tex file)',
    ),
  texFilePath: z
    .string()
    .optional()
    .describe(
      'Path to .tex file for checking unused citations (only for check_unused action)',
    ),
  autoFix: z
    .boolean()
    .optional()
    .describe(
      'Automatically fix issues and save changes (default: false, only report)',
    ),
});

export type ManageBibliographyInput = z.infer<
  typeof ManageBibliographyInputSchema
>;

interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  rawEntry: string;
}

interface ValidationIssue {
  key: string;
  type: 'error' | 'warning';
  message: string;
}

export class ManageBibliographyTool extends defineTool({
  name: 'manage_bibliography',
  description:
    'Manage bibliography file: validate entries, find duplicates, check for unused citations, format .bib file, and get statistics.',
  schema: ManageBibliographyInputSchema,
}) {
  private async readBibFile(bibPath: string): Promise<string> {
    if (!(await WorkspaceFS.exists(bibPath))) {
      throw new ToolError(`Bibliography file not found: ${bibPath}`);
    }
    return await WorkspaceFS.read(bibPath);
  }

  private async writeBibFile(
    bibPath: string,
    content: string,
  ): Promise<void> {
    await WorkspaceFS.write(bibPath, content);
    logger.info(CHANNEL, `Updated bibliography file: ${bibPath}`);
  }

  private parseBibFile(bibContent: string): BibEntry[] {
    try {
      const parsed = bibtexParser.parse(bibContent, {
        verbatimFields: ['abstract', 'url', 'file'],
      });

      const entries: BibEntry[] = [];

      for (const entry of parsed.entries || []) {
        const fields: Record<string, string> = {};

        for (const [key, value] of Object.entries(entry.fields)) {
          fields[key] = String(value);
        }

        // Extract raw entry from original content
        const keyPattern = new RegExp(
          `@\\w+\\{${entry.key},.*?\\n\\}`,
          'is',
        );
        const rawMatch = bibContent.match(keyPattern);
        const rawEntry = rawMatch ? rawMatch[0] : '';

        entries.push({
          key: entry.key || 'unknown',
          type: entry.type || 'misc',
          fields,
          rawEntry,
        });
      }

      return entries;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to parse bibliography: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ToolError(
        `Failed to parse bibliography file. Please check for syntax errors.`,
      );
    }
  }

  private validateEntry(entry: BibEntry): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Required fields by entry type
    const requiredFields: Record<string, string[]> = {
      article: ['author', 'title', 'journal', 'year'],
      book: ['author', 'title', 'publisher', 'year'],
      inproceedings: ['author', 'title', 'booktitle', 'year'],
      phdthesis: ['author', 'title', 'school', 'year'],
      mastersthesis: ['author', 'title', 'school', 'year'],
      techreport: ['author', 'title', 'institution', 'year'],
    };

    const required = requiredFields[entry.type] || ['author', 'title', 'year'];

    for (const field of required) {
      if (!entry.fields[field]) {
        issues.push({
          key: entry.key,
          type: 'error',
          message: `Missing required field "${field}" for @${entry.type}`,
        });
      }
    }

    // Check for empty fields
    for (const [field, value] of Object.entries(entry.fields)) {
      if (!value || value.trim() === '') {
        issues.push({
          key: entry.key,
          type: 'warning',
          message: `Empty field "${field}"`,
        });
      }
    }

    return issues;
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[{}]/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private findDuplicates(entries: BibEntry[]): Map<string, string[]> {
    const titleMap = new Map<string, string[]>();

    for (const entry of entries) {
      const title = entry.fields.title;
      if (!title) continue;

      const normalizedTitle = this.normalizeTitle(title);
      const existing = titleMap.get(normalizedTitle) || [];
      existing.push(entry.key);
      titleMap.set(normalizedTitle, existing);
    }

    // Filter to only duplicates
    const duplicates = new Map<string, string[]>();
    for (const [title, keys] of titleMap.entries()) {
      if (keys.length > 1) {
        duplicates.set(title, keys);
      }
    }

    return duplicates;
  }

  private formatEntry(entry: BibEntry): string {
    let bibtex = `@${entry.type}{${entry.key},\n`;

    // Field order for readability
    const fieldOrder = [
      'author',
      'editor',
      'title',
      'booktitle',
      'journal',
      'year',
      'month',
      'volume',
      'number',
      'pages',
      'publisher',
      'organization',
      'institution',
      'school',
      'address',
      'doi',
      'eprint',
      'archivePrefix',
      'primaryClass',
      'url',
      'note',
      'abstract',
    ];

    const addedFields = new Set<string>();

    for (const field of fieldOrder) {
      if (entry.fields[field]) {
        bibtex += `  ${field} = {${entry.fields[field]}},\n`;
        addedFields.add(field);
      }
    }

    // Add remaining fields
    for (const [field, value] of Object.entries(entry.fields)) {
      if (!addedFields.has(field)) {
        bibtex += `  ${field} = {${value}},\n`;
      }
    }

    // Remove trailing comma and close
    bibtex = bibtex.replace(/,\n$/, '\n');
    bibtex += '}\n';

    return bibtex;
  }

  private async findCitedKeys(texPath: string): Promise<Set<string>> {
    const texContent = await WorkspaceFS.read(texPath);
    const citedKeys = new Set<string>();

    // Match \cite{key}, \cite[text]{key}, \citep{key}, \citet{key}, etc.
    const citePattern = /\\cite[pt]?\*?\[?[^\]]*\]?\{([^}]+)\}/g;

    let match;
    while ((match = citePattern.exec(texContent)) !== null) {
      const keys = match[1].split(',').map((k) => k.trim());
      keys.forEach((k) => citedKeys.add(k));
    }

    return citedKeys;
  }

  protected async execute(
    input: ManageBibliographyInput,
  ): Promise<ToolResult> {
    const { bibFilePath, action, texFilePath, autoFix = false } = input;

    // Determine .bib file path
    const centralBibFile = getConfig<string>(
      'texra.bibliography.centralBibFile',
      'references.bib',
    );
    const targetBibPath = bibFilePath || centralBibFile;

    logger.info(
      CHANNEL,
      `Managing bibliography: ${targetBibPath}, action: ${action}`,
    );

    // Read and parse bibliography
    const bibContent = await this.readBibFile(targetBibPath);
    const entries = this.parseBibFile(bibContent);

    if (entries.length === 0) {
      return toolResult({
        summary: `Bibliography file is empty: ${targetBibPath}`,
        output: formatToolOutput(
          'Empty Bibliography',
          'No entries found in bibliography file.',
        ),
      });
    }

    const outputLines: string[] = [];

    if (action === 'validate') {
      const allIssues: ValidationIssue[] = [];

      for (const entry of entries) {
        const issues = this.validateEntry(entry);
        allIssues.push(...issues);
      }

      if (allIssues.length === 0) {
        outputLines.push('✓ No validation issues found!');
      } else {
        const errors = allIssues.filter((i) => i.type === 'error');
        const warnings = allIssues.filter((i) => i.type === 'warning');

        outputLines.push(
          `**Summary:** ${errors.length} errors, ${warnings.length} warnings\n`,
        );

        if (errors.length > 0) {
          outputLines.push('**Errors:**');
          for (const issue of errors) {
            outputLines.push(`- [${issue.key}] ${issue.message}`);
          }
        }

        if (warnings.length > 0) {
          outputLines.push('\n**Warnings:**');
          for (const issue of warnings) {
            outputLines.push(`- [${issue.key}] ${issue.message}`);
          }
        }
      }
    } else if (action === 'deduplicate') {
      const duplicates = this.findDuplicates(entries);

      if (duplicates.size === 0) {
        outputLines.push('✓ No duplicate entries found!');
      } else {
        outputLines.push(
          `**Found ${duplicates.size} duplicate title(s):**\n`,
        );

        for (const [title, keys] of duplicates.entries()) {
          outputLines.push(`**Title:** ${title.substring(0, 60)}...`);
          outputLines.push(`  Keys: ${keys.join(', ')}`);
          outputLines.push('');
        }

        if (autoFix) {
          // Keep first entry of each duplicate group
          const keysToRemove = new Set<string>();
          for (const keys of duplicates.values()) {
            keys.slice(1).forEach((k) => keysToRemove.add(k));
          }

          const dedupedEntries = entries.filter(
            (e) => !keysToRemove.has(e.key),
          );

          const newBibContent = dedupedEntries
            .map((e) => this.formatEntry(e))
            .join('\n');

          await this.writeBibFile(targetBibPath, newBibContent);

          outputLines.push(
            `\n**Auto-fix applied:** Removed ${keysToRemove.size} duplicate entries.`,
          );
        } else {
          outputLines.push(
            '\n*Use autoFix: true to automatically remove duplicates (keeps first entry of each group)*',
          );
        }
      }
    } else if (action === 'format') {
      const formattedContent = entries
        .map((e) => this.formatEntry(e))
        .join('\n');

      if (autoFix) {
        await this.writeBibFile(targetBibPath, formattedContent);
        outputLines.push(
          `✓ Formatted ${entries.length} entries and saved to file.`,
        );
      } else {
        outputLines.push(
          `Found ${entries.length} entries ready to be formatted.`,
        );
        outputLines.push(
          '*Use autoFix: true to apply formatting and save changes*',
        );
      }
    } else if (action === 'analyze') {
      const types = new Map<string, number>();
      const years = new Map<string, number>();

      for (const entry of entries) {
        // Count by type
        const count = types.get(entry.type) || 0;
        types.set(entry.type, count + 1);

        // Count by year
        const year = entry.fields.year || 'Unknown';
        const yearCount = years.get(year) || 0;
        years.set(year, yearCount + 1);
      }

      outputLines.push(`**Total Entries:** ${entries.length}\n`);

      outputLines.push('**By Entry Type:**');
      const sortedTypes = Array.from(types.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [type, count] of sortedTypes) {
        outputLines.push(`  @${type}: ${count}`);
      }

      outputLines.push('\n**By Year:**');
      const sortedYears = Array.from(years.entries()).sort((a, b) =>
        b[0].localeCompare(a[0]),
      );
      for (const [year, count] of sortedYears.slice(0, 10)) {
        outputLines.push(`  ${year}: ${count}`);
      }

      if (sortedYears.length > 10) {
        outputLines.push(`  ... (${sortedYears.length - 10} more years)`);
      }
    } else if (action === 'check_unused') {
      if (!texFilePath) {
        throw new ToolError(
          'texFilePath is required for check_unused action',
        );
      }

      const citedKeys = await this.findCitedKeys(texFilePath);
      const unusedEntries = entries.filter(
        (e) => !citedKeys.has(e.key),
      );

      if (unusedEntries.length === 0) {
        outputLines.push('✓ All bibliography entries are cited!');
      } else {
        outputLines.push(
          `**Found ${unusedEntries.length} unused entries** (not cited in ${texFilePath}):\n`,
        );

        for (const entry of unusedEntries.slice(0, 20)) {
          const title = entry.fields.title || 'No title';
          outputLines.push(
            `- **${entry.key}**: ${title.substring(0, 60)}...`,
          );
        }

        if (unusedEntries.length > 20) {
          outputLines.push(
            `\n... and ${unusedEntries.length - 20} more`,
          );
        }

        outputLines.push(
          `\n*Total cited: ${citedKeys.size}, Total in .bib: ${entries.length}*`,
        );
      }
    }

    const output = formatToolOutput(
      `Bibliography Management: ${action}`,
      outputLines.join('\n'),
    );

    return toolResult({
      summary: `Performed ${action} on ${targetBibPath} (${entries.length} entries)`,
      output,
    });
  }
}
