// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { formatToolOutput, resolveAndFormat } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { pathToLocation } from '@utils/files';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
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
    const { resolved, display } = await resolveLatexFileOrThrow(texPath);

    const figurePaths = await extractFigurePathsFromLatex(
      pathToLocation(resolved.absolute),
    );
    const uniqueFigures = Array.from(new Set(figurePaths));

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

    const formattedList = limitedPaths.map((path) => {
      const { display: figureDisplay } = resolveAndFormat(path);
      return `- ${figureDisplay}`;
    });
    const header = `Figures referenced in ${display}`;
    const output = formatToolOutput(header, formattedList);
    const summary = `Found ${limitedPaths.length} figure file${
      limitedPaths.length === 1 ? '' : 's'
    } in ${display}.`;

    const result = {
      summary,
      output,
      files: attachments,
    };

    if (limitReached) {
      result.userInstruction = `Limited attachments to ${attachments.length} files.`;
    }

    return result;
  }
}
