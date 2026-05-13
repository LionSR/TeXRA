// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { formatToolOutput } from '@tools/formatting';
import { resolveAndFormat } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { pathToLocation } from '@utils/files';
import {
  buildLimitedAttachments,
  resolveLatexFileOrThrow,
} from './figureExtractionShared';

const ExtractFiguresInputSchema = z.strictObject({
  texPath: z
    .string()
    .min(1, 'texPath is required.')
    .describe('Path to the primary LaTeX file to inspect.'),
});

export type ExtractFiguresInput = z.infer<typeof ExtractFiguresInputSchema>;

const DEFAULT_MAX_FILES = 20;

export class ExtractLatexFiguresTool extends defineTool({
  name: 'extract_figures',
  description:
    'Resolve and list figure assets referenced by a LaTeX document, returning attachments when available.',
  schema: ExtractFiguresInputSchema,
}) {
  protected async execute({ texPath }: ExtractFiguresInput) {
    const { path, display } = await resolveLatexFileOrThrow(texPath);

    const figurePaths = await extractFigurePathsFromLatex(
      pathToLocation(path.absolute),
    );
    const uniqueFigures = [...new Set(figurePaths)];

    if (uniqueFigures.length === 0) {
      const summary = `No figures found in ${display}.`;
      return {
        summary,
        output: formatToolOutput('Figures', null),
      };
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
    const summary = `Found ${limitedPaths.length} figure file${
      limitedPaths.length === 1 ? '' : 's'
    } in ${display}.`;

    const fullOutput = limitReached
      ? `${output}\n\nNote: Limited attachments to ${attachments.length} files.`
      : output;

    return {
      summary,
      output: fullOutput,
      files: attachments,
    };
  }
}
