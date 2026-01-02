// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError } from '@tools/result';
import { formatToolOutput, resolveAndFormat } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';

const ExtractBibliographyInputSchema = z.strictObject({
  texPath: z
    .string()
    .min(1, 'texPath is required.')
    .describe('Path to the LaTeX file to scan for citations.'),
  bibPath: z
    .string()
    .min(1, 'bibPath cannot be empty if provided.')
    .describe(
      'Optional path to a BibTeX file to include when resolving citations.',
    )
    .nullish(),
});

export type ExtractBibliographyInput = z.infer<
  typeof ExtractBibliographyInputSchema
>;

const DEFAULT_MAX_ENTRIES = 25;

export class ExtractBibliographyTool extends defineTool({
  name: 'extract_bib_entries',
  description:
    'Collect BibTeX records for citations referenced in a LaTeX document.',
  schema: ExtractBibliographyInputSchema,
}) {
  protected async execute({ texPath, bibPath }: ExtractBibliographyInput) {
    const { resolved, display } = resolveAndFormat(texPath);

    if (!(await WorkspaceFS.exists(resolved.relative))) {
      throw new ToolError(`LaTeX file not found: ${display}`);
    }

    const context = await extractBibliographyContext(resolved.relative);
    const bibliographyFiles = [...context.bibliographyFiles];
    const missingBibliographyFiles = [...context.missingBibliographyFiles];
    let citationKeys = [...context.citationKeys];

    if (bibPath) {
      const { resolved: bibResolved } = resolveAndFormat(bibPath);
      const candidate = bibResolved.relative;
      const exists = await WorkspaceFS.exists(candidate);
      const target = exists ? bibliographyFiles : missingBibliographyFiles;
      if (!target.includes(candidate)) {
        target.push(candidate);
      }
    }

    if (bibPath && citationKeys.length === 0) {
      citationKeys = ['*'];
    }

    if (
      citationKeys.length === 0 &&
      bibliographyFiles.length === 0 &&
      missingBibliographyFiles.length === 0
    ) {
      const summary = `No citations or bibliography directives found in ${display}.`;
      return {
        summary,
        output: formatToolOutput(`BibTeX entries in ${display}`, null),
      };
    }

    if (citationKeys.length === 0) {
      const summary = `No citation commands found in ${display}.`;
      return {
        summary,
        output: formatToolOutput(`BibTeX entries in ${display}`, null),
        ...(missingBibliographyFiles.length > 0 && {
          userInstruction: `Missing bibliography files: ${missingBibliographyFiles
            .map((file) => resolveAndFormat(file).display)
            .join(', ')}.`,
        }),
      };
    }

    const { entries, missingKeys } = await loadBibliographyEntries(
      bibliographyFiles,
      citationKeys,
    );

    const entryLines = summarizeBibliographyEntries(
      entries,
      DEFAULT_MAX_ENTRIES,
    );
    const output = formatToolOutput(
      `BibTeX entries cited in ${display}`,
      entryLines,
      'No matching entries found.',
    );

    const entryCount = entries.size;
    const citationCount = citationKeys.length;

    const summary =
      entryCount === 0
        ? `No matching bibliography entries found for ${citationCount} citation key${
            citationCount === 1 ? '' : 's'
          } in ${display}.`
        : `Resolved ${entryCount} bibliography entr${
            entryCount === 1 ? 'y' : 'ies'
          } for ${citationCount} citation key${
            citationCount === 1 ? '' : 's'
          } in ${display}.`;

    const instructions: string[] = [];
    if (missingBibliographyFiles.length > 0) {
      instructions.push(
        `Missing bibliography files: ${missingBibliographyFiles
          .map((file) => resolveAndFormat(file).display)
          .join(', ')}.`,
      );
    }
    if (missingKeys.length > 0) {
      instructions.push(
        `Missing citation keys: ${missingKeys
          .map((key) => `\`${key}\``)
          .join(', ')}.`,
      );
    }
    if (entries.size > DEFAULT_MAX_ENTRIES) {
      instructions.push(`Limited output to ${DEFAULT_MAX_ENTRIES} entries.`);
    }

    return {
      summary,
      output,
      ...(instructions.length > 0 && {
        userInstruction: instructions.join(' '),
      }),
    };
  }
}
