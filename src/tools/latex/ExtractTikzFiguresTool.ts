// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { tikzPictureManager } from '@latex/TikzPictureManager';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult, type ToolFileAttachment } from '@tools/result';
import {
  buildFileAttachment,
  formatToolOutput,
  resolveAndFormat,
} from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const ExtractTikzInputSchema = z.strictObject({
  texPath: z
    .string()
    .min(1, 'texPath is required.')
    .describe('Path to the LaTeX file containing TikZ figures.'),
  compile: z
    .boolean()
    .describe('Compile extracted TikZ pictures into standalone PDFs.')
    .optional(),
});

export type ExtractTikzInput = z.infer<typeof ExtractTikzInputSchema>;

const DEFAULT_TIKZ_MAX_FILES = 12;

export class ExtractTikzFiguresTool extends defineTool({
  name: 'extract_tikz_figures',
  description:
    'Discover TikZ figures inside a LaTeX document and optionally compile them into standalone PDFs.',
  schema: ExtractTikzInputSchema,
}) {
  protected async execute({ texPath, compile = true }: ExtractTikzInput) {
    const { resolved, display } = resolveAndFormat(texPath);

    if (!(await WorkspaceFS.exists(resolved.relative))) {
      throw new ToolError(`LaTeX file not found: ${display}`);
    }

    const tikzFigures = await tikzPictureManager.extract(resolved.relative);
    if (tikzFigures.length === 0) {
      const summary = `No TikZ figures found in ${display}.`;
      return toolResult({
        summary,
        output: formatToolOutput('TikZ figures', null),
      });
    }

    const formattedEntries = tikzFigures.map(([label, pictures]) => {
      const pictureCount = pictures.length;
      const suffix = pictureCount === 1 ? '' : 's';
      return `- ${label || '(unlabeled)'}: ${pictureCount} picture${suffix}`;
    });
    const outputs: string[] = [
      formatToolOutput(`TikZ figures in ${display}`, formattedEntries),
    ];

    const summaryParts = [
      `Found ${tikzFigures.length} TikZ figure${
        tikzFigures.length === 1 ? '' : 's'
      } in ${display}.`,
    ];

    let attachments: ToolFileAttachment[] | undefined;
    if (compile) {
      const compiledPaths = await tikzPictureManager.compile(resolved.relative);
      if (compiledPaths.length > 0) {
        const limit = Math.min(compiledPaths.length, DEFAULT_TIKZ_MAX_FILES);
        const limited = compiledPaths.slice(0, limit);
        attachments = await Promise.all(
          limited.map((pdfPath) =>
            buildFileAttachment({
              filePath: pdfPath,
              description: `Standalone TikZ figure derived from ${display}`,
              mimeType: 'application/pdf',
            }),
          ),
        );
        summaryParts.push(
          `Compiled ${limited.length} standalone PDF${
            limited.length === 1 ? '' : 's'
          }.`,
        );
        outputs.push(
          formatToolOutput(
            'Compiled PDFs',
            attachments.map((file) => `- ${file.path}`),
          ),
        );
        if (compiledPaths.length > limit) {
          summaryParts.push(
            `Limited attachments to ${limit} file${limit === 1 ? '' : 's'}.`,
          );
        }
      } else {
        summaryParts.push('Compilation produced no PDF outputs.');
      }
    }

    return toolResult({
      summary: summaryParts.join(' '),
      output: outputs.join('\n'),
      files: attachments,
    });
  }
}
