// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { toolResult, type ToolFileAttachment } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { pathToLocation } from '@utils/files';
import { tikzPictureManager } from '@latex/TikzPictureManager';
import {
  buildLimitedAttachments,
  resolveLatexFileOrThrow,
} from './figureExtractionShared';

const ExtractTikzInputSchema = z.strictObject({
  texPath: z
    .string()
    .min(1, 'texPath is required.')
    .describe('Path to the LaTeX file containing TikZ figures.'),
  compile: z
    .boolean()
    .describe('Compile extracted TikZ pictures into standalone PDFs.')
    .nullish(),
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
    const { resolved, display } = await resolveLatexFileOrThrow(texPath);

    const tikzFigures = await tikzPictureManager.extract(
      pathToLocation(resolved.absolute),
    );
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
      return `- ${label ?? '(unlabeled)'}: ${pictureCount} picture${suffix}`;
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
      const compiledPaths = await tikzPictureManager.compile(
        pathToLocation(resolved.absolute),
      );
      if (compiledPaths.length > 0) {
        // Convert FileLocation[] to string[] for legacy attachment API
        const compiledPathStrings = compiledPaths.map(
          (loc) => loc.absolutePath,
        );
        const {
          attachments: compiledAttachments,
          limitedPaths,
          limitReached,
        } = await buildLimitedAttachments(compiledPathStrings, {
          limit: DEFAULT_TIKZ_MAX_FILES,
          describe: () => `Standalone TikZ figure derived from ${display}`,
          mimeType: 'application/pdf',
        });
        attachments = compiledAttachments;
        summaryParts.push(
          `Compiled ${limitedPaths.length} standalone PDF${
            limitedPaths.length === 1 ? '' : 's'
          }.`,
        );
        outputs.push(
          formatToolOutput(
            'Compiled PDFs',
            compiledAttachments.map((file) => `- ${file.path}`),
          ),
        );
        if (limitReached) {
          summaryParts.push(
            `Limited attachments to ${compiledAttachments.length} file${
              compiledAttachments.length === 1 ? '' : 's'
            }.`,
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
