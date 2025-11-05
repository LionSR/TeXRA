import { z } from 'zod';
import { Cite } from 'citation-js';
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ManageBibliography';
logger.initialize(CHANNEL);

export class ManageBibliographyTool extends defineTool({
  name: 'manage_bibliography',
  description:
    'Manage bibliography: validate entries, find duplicates, check unused citations, and get statistics.',
  schema: z.strictObject({
    bibFilePath: z.string().optional().describe('Path to .bib file'),
    action: z.enum(['validate', 'deduplicate', 'analyze', 'check_unused']),
    texFilePath: z.string().optional().describe('Path to .tex file (for check_unused)'),
    autoFix: z.boolean().optional().describe('Auto-fix and save'),
  }),
}) {
  protected async execute(input: z.infer<typeof this.schema>) {
    const { action, texFilePath, autoFix = false } = input;
    const bibPath = input.bibFilePath || getConfig('texra.bibliography.centralBibFile', 'references.bib');

    logger.info(CHANNEL, `Managing ${bibPath}: ${action}`);

    if (!(await WorkspaceFS.exists(bibPath))) {
      throw new ToolError(`Bibliography file not found: ${bibPath}`);
    }

    const bibContent = await WorkspaceFS.read(bibPath);
    const citation = new Cite(bibContent);
    const entries = citation.data;

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

      outputLines.push(
        issues.length === 0
          ? '✓ No validation issues found!'
          : `**Found ${issues.length} issue(s):**\n` + issues.slice(0, 20).join('\n')
      );

      if (issues.length > 20) {
        outputLines.push(`\n... and ${issues.length - 20} more`);
      }
    }

    if (action === 'deduplicate') {
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
          const idsToRemove = new Set<string>();
          for (const ids of duplicates.values()) {
            ids.slice(1).forEach(id => idsToRemove.add(id));
          }

          const dedupedEntries = entries.filter(e => !idsToRemove.has(e.id));
          const newCitation = new Cite(dedupedEntries);
          await WorkspaceFS.write(bibPath, newCitation.format('bibtex'));

          outputLines.push(`\n✓ Removed ${idsToRemove.size} duplicate entries.`);
        } else {
          outputLines.push('\n*Use autoFix: true to remove duplicates*');
        }
      }
    }

    if (action === 'analyze') {
      const types = new Map<string, number>();
      const years = new Map<string, number>();

      for (const entry of entries) {
        const type = entry.type || 'unknown';
        types.set(type, (types.get(type) || 0) + 1);

        const year = entry.issued?.['date-parts']?.[0]?.[0]?.toString() || 'Unknown';
        years.set(year, (years.get(year) || 0) + 1);
      }

      outputLines.push(`**Total Entries:** ${entries.length}\n`);
      outputLines.push('**By Type:**');
      outputLines.push(...Array.from(types).sort((a, b) => b[1] - a[1]).map(([t, c]) => `  ${t}: ${c}`));

      outputLines.push('\n**By Year:**');
      const sortedYears = Array.from(years).sort((a, b) => b[0].localeCompare(a[0]));
      outputLines.push(...sortedYears.slice(0, 10).map(([y, c]) => `  ${y}: ${c}`));

      if (sortedYears.length > 10) {
        outputLines.push(`  ... (${sortedYears.length - 10} more)`);
      }
    }

    if (action === 'check_unused') {
      if (!texFilePath) {
        throw new ToolError('texFilePath is required for check_unused action');
      }

      const citedKeys = await this.getCitedKeys(texFilePath);
      const unusedEntries = entries.filter(e => !citedKeys.has(e.id));

      if (unusedEntries.length === 0) {
        outputLines.push('✓ All entries are cited!');
      } else {
        outputLines.push(`**Found ${unusedEntries.length} unused entries:**\n`);
        outputLines.push(...unusedEntries.slice(0, 20).map(e => {
          const title = e.title || 'No title';
          return `- **${e.id}**: ${title.substring(0, 60)}...`;
        }));

        if (unusedEntries.length > 20) {
          outputLines.push(`\n... and ${unusedEntries.length - 20} more`);
        }

        outputLines.push(`\n*Cited: ${citedKeys.size}, Total: ${entries.length}*`);
      }
    }

    return toolResult({
      summary: `Performed ${action} on ${bibPath} (${entries.length} entries)`,
      output: formatToolOutput(`Bibliography Management: ${action}`, outputLines.join('\n')),
    });
  }

  private findDuplicates(entries: any[]): Map<string, string[]> {
    const titleMap = new Map<string, string[]>();

    for (const entry of entries) {
      if (!entry.title) continue;

      // Normalize title without regex
      const normalized = entry.title
        .toLowerCase()
        .split('')
        .filter((c: string) => (c >= 'a' && c <= 'z') || c === ' ')
        .join('')
        .split(' ')
        .filter((w: string) => w.length > 0)
        .join(' ');

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

    // Regex as last resort for parsing LaTeX cite commands
    const citePattern = /\\cite[pt]?\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;
    let match;

    while ((match = citePattern.exec(texContent)) !== null) {
      const keys = match[1].split(',').map(k => k.trim());
      keys.forEach(k => citedKeys.add(k));
    }

    return citedKeys;
  }
}
