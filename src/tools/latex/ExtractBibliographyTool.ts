// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - tools
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';
import type { ToolResult } from '@shared/schemas';
import { formatToolOutput } from '@tools/formatting';
import { resolveAndFormat } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { ensureError } from '@utils/errors/errorMessage';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { formatResultCount } from '@utils/text/stringUtils';
import { getConfig } from '@utils/config/configUtils';
import {
  emptyExtractionResult,
  resolveLatexFile,
  texPathField,
} from './figureExtractionShared';

const ExtractBibliographyInputSchema = z.strictObject({
  texPath: texPathField('Path to the LaTeX file to scan for citations.'),
  bibPath: z
    .string()
    .min(1, 'bibPath cannot be empty if provided.')
    .describe(
      'Optional path to a BibTeX file to include when resolving citations.',
    )
    .nullish(),
});

type ExtractBibliographyInput = z.infer<typeof ExtractBibliographyInputSchema>;

const DEFAULT_MAX_ENTRIES = 25;

function formatPathList(filePaths: string[]): string {
  return filePaths
    .map((filePath) => resolveAndFormat(filePath).display)
    .join(', ');
}

const extractBibliography = Effect.fn('ExtractBibliographyTool.execute')(
  function* ({
    texPath,
    bibPath,
  }: ExtractBibliographyInput): Effect.fn.Return<ToolResult, Error, ToolCall> {
    const call = yield* ToolCall;
    const { path, display } = yield* resolveLatexFile(texPath);

    const context = yield* extractBibliographyContext(path.absolute);
    const bibliographyFiles = [...context.bibliographyFiles];
    const missingBibliographyFiles = [...context.missingBibliographyFiles];
    let citationKeys = [...context.citationKeys];

    // Use provided bibPath, or fall back to configured default
    const effectiveBibPath =
      bibPath || call.inScope(() => getConfig<string>('texra.bib.defaultPath'));

    if (effectiveBibPath) {
      const { path: resolved } = call.inScope(() =>
        resolveAndFormat(effectiveBibPath, call.workingDirectory),
      );
      const exists = yield* Effect.tryPromise({
        try: () => call.inScope(() => WorkspaceFS.exists(resolved.fsPath)),
        catch: ensureError,
      });
      const target = exists ? bibliographyFiles : missingBibliographyFiles;
      if (!target.includes(resolved.absolute)) {
        target.push(resolved.absolute);
      }
      if (citationKeys.length === 0) {
        citationKeys = ['*'];
      }
    }

    if (
      citationKeys.length === 0 &&
      bibliographyFiles.length === 0 &&
      missingBibliographyFiles.length === 0
    ) {
      return emptyExtractionResult(
        `BibTeX entries in ${display}`,
        `No citations or bibliography directives found in ${display}.`,
      );
    }

    if (citationKeys.length === 0) {
      const missingNote =
        missingBibliographyFiles.length > 0
          ? `\n\nNote: Missing bibliography files: ${call.inScope(() => formatPathList(missingBibliographyFiles))}.`
          : '';
      const result = emptyExtractionResult(
        `BibTeX entries in ${display}`,
        `No citation commands found in ${display}.`,
      );
      return { ...result, output: `${result.output}${missingNote}` };
    }

    const { entries, missingKeys } = yield* loadBibliographyEntries(
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
    const citationKeyCount = formatResultCount(
      citationKeys.length,
      'citation key',
    );

    const summary =
      entryCount === 0
        ? `No matching bibliography entries found for ${citationKeyCount} in ${display}.`
        : `Resolved ${formatResultCount(entryCount, 'bibliography entry', 'bibliography entries')} for ${citationKeyCount} in ${display}.`;

    const instructions = [
      missingBibliographyFiles.length > 0 &&
        `Missing bibliography files: ${call.inScope(() => formatPathList(missingBibliographyFiles))}.`,
      missingKeys.length > 0 &&
        `Missing citation keys: ${missingKeys.map((k) => `\`${k}\``).join(', ')}.`,
      entryCount > DEFAULT_MAX_ENTRIES &&
        `Limited output to ${DEFAULT_MAX_ENTRIES} entries.`,
    ].filter((x): x is string => Boolean(x));

    const notes =
      instructions.length > 0 ? `\n\nNote: ${instructions.join(' ')}` : '';

    return executed(`${output}${notes}`, summary);
  },
);

export class ExtractBibliographyTool extends defineTool({
  name: 'extract_bib_entries',
  description:
    'Collect BibTeX records for citations referenced in a LaTeX document.',
  schema: ExtractBibliographyInputSchema,
}) {
  protected execute(input: ExtractBibliographyInput) {
    return extractBibliography(input);
  }
}
