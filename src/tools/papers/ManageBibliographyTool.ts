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

const CHANNEL = 'ManageBibliography';
logger.initialize(CHANNEL);

const ManageBibliographyInputSchema = z.strictObject({
  bibFilePath: z
    .string()
    .optional()
    .describe('Path to .bib file (defaults to configured central file)'),
  action: z
    .enum(['validate', 'deduplicate', 'analyze', 'check_unused'])
    .describe(
      'Action: validate (check issues), deduplicate (remove duplicates), analyze (get stats), check_unused (find unused citations)'
    ),
  texFilePath: z
    .string()
    .optional()
    .describe('Path to .tex file (required for check_unused action)'),
  autoFix: z
    .boolean()
    .optional()
    .describe('Auto-fix issues and save (default: false)'),
});

export type ManageBibliographyInput = z.infer<typeof ManageBibliographyInputSchema>;

export class ManageBibliographyTool extends defineTool({
  name: 'manage_bibliography',
  description:
    'Manage bibliography: validate entries, find duplicates, check unused citations, and get statistics.',
  schema: ManageBibliographyInputSchema,
}) {
  private parseBibtex(bibContent: string): any[] {
    try {
      const citation = new Cite(bibContent);
      return citation.data;
    } catch (err) {
      throw new ToolError('Failed to parse bibliography file. Check for syntax errors.');
    }
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[{}]/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private findDuplicates(entries: any[]): Map<string, string[]> {
    const titleMap = new Map<string, string[]>();

    for (const entry of entries) {
      const title = entry.title;
      if (!title) continue;

      const normalized = this.normalizeTitle(title);
      const ids = titleMap.get(normalized) || [];
      ids.push(entry.id || 'unknown');
      titleMap.set(normalized, ids);
    }

    // Return only duplicates
    const duplicates = new Map<string, string[]>();
    for (const [title, ids] of titleMap) {
      if (ids.length > 1) {
        duplicates.set(title, ids);
      }
    }

    return duplicates;
  }

  private async getCitedKeys(texPath: string): Promise<Set<string>> {
    const texContent = await WorkspaceFS.read(texPath);
    const citedKeys = new Set<string>();

    // Match \cite{key1,key2}, \citep{key}, \citet{key}, etc.
    const citePattern = /\\cite[pt]?\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;

    let match;
    while ((match = citePattern.exec(texContent)) !== null) {
      const keys = match[1].split(',').map((k) => k.trim());
      keys.forEach((k) => citedKeys.add(k));
    }

    return citedKeys;
  }

  protected async execute(input: ManageBibliographyInput): Promise<ToolResult> {
    const { action, texFilePath, autoFix = false } = input;

    const centralFile = getConfig('texra.bibliography.centralBibFile', 'references.bib');
    const bibPath = input.bibFilePath || centralFile;

    logger.info(CHANNEL, `Managing ${bibPath}: ${action}`);

    // Read and parse bibliography
    if (!(await WorkspaceFS.exists(bibPath))) {
      throw new ToolError(`Bibliography file not found: ${bibPath}`);
    }

    const bibContent = await WorkspaceFS.read(bibPath);
    const entries = this.parseBibtex(bibContent);

    if (entries.length === 0) {
      return toolResult({
        summary: 'Bibliography file is empty',
        output: formatToolOutput('Empty Bibliography', 'No entries found.'),
      });
    }

    const outputLines: string[] = [];

    if (action === 'validate') {
      const issues: string[] = [];
      const requiredFields = ['author', 'title', 'year'];

      for (const entry of entries) {
        const id = entry.id || 'unknown';
        for (const field of requiredFields) {
          if (!entry[field]) {
            issues.push(`[${id}] Missing "${field}"`);
          }
        }
      }

      if (issues.length === 0) {
        outputLines.push('✓ No validation issues found!');
      } else {
        outputLines.push(`**Found ${issues.length} issue(s):**\n`);
        outputLines.push(...issues.slice(0, 20));
        if (issues.length > 20) {
          outputLines.push(`\n... and ${issues.length - 20} more`);
        }
      }
    } else if (action === 'deduplicate') {
      const duplicates = this.findDuplicates(entries);

      if (duplicates.size === 0) {
        outputLines.push('✓ No duplicate entries found!');
      } else {
        outputLines.push(`**Found ${duplicates.size} duplicate(s):**\n`);

        for (const [title, ids] of duplicates) {
          outputLines.push(`**Title:** ${title.substring(0, 60)}...`);
          outputLines.push(`  Keys: ${ids.join(', ')}\n`);
        }

        if (autoFix) {
          // Keep first entry of each duplicate group
          const idsToRemove = new Set<string>();
          for (const ids of duplicates.values()) {
            ids.slice(1).forEach((id) => idsToRemove.add(id));
          }

          const dedupedEntries = entries.filter((e) => !idsToRemove.has(e.id));
          const newCitation = new Cite(dedupedEntries);
          const newBibtex = newCitation.format('bibtex');

          await WorkspaceFS.write(bibPath, newBibtex);

          outputLines.push(`\n✓ Removed ${idsToRemove.size} duplicate entries.`);
        } else {
          outputLines.push('\n*Use autoFix: true to remove duplicates (keeps first of each group)*');
        }
      }
    } else if (action === 'analyze') {
      const types = new Map<string, number>();
      const years = new Map<string, number>();

      for (const entry of entries) {
        // Count by type
        const type = entry.type || 'unknown';
        types.set(type, (types.get(type) || 0) + 1);

        // Count by year
        const year = entry.issued?.['date-parts']?.[0]?.[0]?.toString() || 'Unknown';
        years.set(year, (years.get(year) || 0) + 1);
      }

      outputLines.push(`**Total Entries:** ${entries.length}\n`);

      outputLines.push('**By Type:**');
      const sortedTypes = Array.from(types).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sortedTypes) {
        outputLines.push(`  ${type}: ${count}`);
      }

      outputLines.push('\n**By Year:**');
      const sortedYears = Array.from(years).sort((a, b) => b[0].localeCompare(a[0]));
      for (const [year, count] of sortedYears.slice(0, 10)) {
        outputLines.push(`  ${year}: ${count}`);
      }

      if (sortedYears.length > 10) {
        outputLines.push(`  ... (${sortedYears.length - 10} more)`);
      }
    } else if (action === 'check_unused') {
      if (!texFilePath) {
        throw new ToolError('texFilePath is required for check_unused action');
      }

      const citedKeys = await this.getCitedKeys(texFilePath);
      const unusedEntries = entries.filter((e) => !citedKeys.has(e.id));

      if (unusedEntries.length === 0) {
        outputLines.push('✓ All entries are cited!');
      } else {
        outputLines.push(`**Found ${unusedEntries.length} unused entries:**\n`);

        for (const entry of unusedEntries.slice(0, 20)) {
          const title = entry.title || 'No title';
          outputLines.push(`- **${entry.id}**: ${title.substring(0, 60)}...`);
        }

        if (unusedEntries.length > 20) {
          outputLines.push(`\n... and ${unusedEntries.length - 20} more`);
        }

        outputLines.push(`\n*Cited: ${citedKeys.size}, Total: ${entries.length}*`);
      }
    }

    const output = formatToolOutput(
      `Bibliography Management: ${action}`,
      outputLines.join('\n')
    );

    return toolResult({
      summary: `Performed ${action} on ${bibPath} (${entries.length} entries)`,
      output,
    });
  }
}
