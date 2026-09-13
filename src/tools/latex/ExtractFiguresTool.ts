// Third-party imports
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - tools
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import type { ToolResult } from '@shared/schemas';
import { formatToolOutput } from '@tools/formatting';
import { resolveAndFormat } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { unique } from '@utils/core';
import { pathToLocation } from '@utils/files/fileLocation';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  buildLimitedAttachments,
  emptyExtractionResult,
  resolveLatexFile,
  texPathField,
} from './figureExtractionShared';

const ExtractFiguresInputSchema = z.strictObject({
  texPath: texPathField('Path to the primary LaTeX file to inspect.'),
});

type ExtractFiguresInput = z.infer<typeof ExtractFiguresInputSchema>;

const DEFAULT_MAX_FILES = 20;

const extractFigures = Effect.fn('ExtractLatexFiguresTool.execute')(function* ({
  texPath,
}: ExtractFiguresInput): Effect.fn.Return<
  ToolResult,
  Error,
  ToolCall | FileSystem.FileSystem
> {
  const call = yield* ToolCall;
  const { path, display } = yield* resolveLatexFile(texPath);

  const figurePaths = yield* extractFigurePathsFromLatex(
    pathToLocation(path.absolute),
  );
  const uniqueFigures = unique(figurePaths);

  if (uniqueFigures.length === 0) {
    return emptyExtractionResult('Figures', `No figures found in ${display}.`);
  }

  const { attachments, limitedPaths, limitReached } =
    yield* buildLimitedAttachments(uniqueFigures, {
      limit: DEFAULT_MAX_FILES,
      describe: () => `Figure referenced by ${display}`,
    });

  const formattedList = limitedPaths.map(
    (figurePath) =>
      `- ${call.inScope(() => resolveAndFormat(figurePath, call.workingDirectory)).display}`,
  );
  const header = `Figures referenced in ${display}`;
  const output = formatToolOutput(header, formattedList);
  const summary = `Found ${formatResultCount(uniqueFigures.length, 'figure file')} in ${display}.`;

  const fullOutput = limitReached
    ? `${output}\n\nNote: Limited attachments to ${attachments.length} of ${uniqueFigures.length} files.`
    : output;

  return {
    status: 'executed',
    summary,
    output: fullOutput,
    files: attachments,
  };
});

export class ExtractLatexFiguresTool extends defineTool({
  name: 'extract_figures',
  description:
    'Resolve and list figure assets referenced by a LaTeX document, returning attachments when available.',
  schema: ExtractFiguresInputSchema,
}) {
  protected execute(input: ExtractFiguresInput) {
    return extractFigures(input);
  }
}
