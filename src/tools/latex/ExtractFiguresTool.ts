// Third-party imports
import { z } from 'zod';

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
  resolveLatexFileOrThrow,
  texPathField,
} from './figureExtractionShared';

const ExtractFiguresInputSchema = z.strictObject({
  texPath: texPathField('Path to the primary LaTeX file to inspect.'),
});

type ExtractFiguresInput = z.infer<typeof ExtractFiguresInputSchema>;

const DEFAULT_MAX_FILES = 20;

export class ExtractLatexFiguresTool extends defineTool({
  name: 'extract_figures',
  description:
    'Resolve and list figure assets referenced by a LaTeX document, returning attachments when available.',
  schema: ExtractFiguresInputSchema,
}) {
  protected async execute({
    texPath,
  }: ExtractFiguresInput): Promise<ToolResult> {
    const { path, display } = await resolveLatexFileOrThrow(texPath);

    const figurePaths = await extractFigurePathsFromLatex(
      pathToLocation(path.absolute),
    );
    const uniqueFigures = unique(figurePaths);

    if (uniqueFigures.length === 0) {
      return emptyExtractionResult(
        'Figures',
        `No figures found in ${display}.`,
      );
    }

    const { attachments, limitedPaths, limitReached } =
      await buildLimitedAttachments(uniqueFigures, {
        limit: DEFAULT_MAX_FILES,
        describe: () => `Figure referenced by ${display}`,
      });

    const formattedList = limitedPaths.map(
      (figurePath) => `- ${resolveAndFormat(figurePath).display}`,
    );
    const header = `Figures referenced in ${display}`;
    const output = formatToolOutput(header, formattedList);
    const summary = `Found ${formatResultCount(limitedPaths.length, 'figure file')} in ${display}.`;

    const fullOutput = limitReached
      ? `${output}\n\nNote: Limited attachments to ${attachments.length} files.`
      : output;

    return {
      status: 'executed',
      summary,
      output: fullOutput,
      files: attachments,
    };
  }
}
