// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { extractFigurePathsFromLatex } from '@latex/extractFigure';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '@tools/result';
import {
  buildFileAttachment,
  formatToolOutput,
  resolveAndFormat,
} from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

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
    const { resolved, display } = resolveAndFormat(texPath);

    if (!(await WorkspaceFS.exists(resolved.relative))) {
      throw new ToolError(`LaTeX file not found: ${display}`);
    }

    const figurePaths = await extractFigurePathsFromLatex(resolved.relative);
    const uniqueFigures = Array.from(new Set(figurePaths));

    if (uniqueFigures.length === 0) {
      const summary = `No figures found in ${display}.`;
      return toolResult({
        summary,
        output: formatToolOutput('Figures', null),
      });
    }

    const limit = Math.min(uniqueFigures.length, DEFAULT_MAX_FILES);
    const limitedFigures = uniqueFigures.slice(0, limit);

    const attachments = await Promise.all(
      limitedFigures.map((figurePath) =>
        buildFileAttachment({
          filePath: figurePath,
          description: `Figure referenced by ${display}`,
        }),
      ),
    );

    const formattedList = limitedFigures.map((path) => {
      const { display: figureDisplay } = resolveAndFormat(path);
      return `- ${figureDisplay}`;
    });
    const header = `Figures referenced in ${display}`;
    const output = formatToolOutput(header, formattedList);
    const summary = `Found ${limitedFigures.length} figure file${
      limitedFigures.length === 1 ? '' : 's'
    } in ${display}.`;

    const result = toolResult({
      summary,
      output,
      files: attachments,
    });

    if (uniqueFigures.length > limit) {
      result.system = `Limited attachments to ${limit} files.`;
    }

    return result;
  }
}
