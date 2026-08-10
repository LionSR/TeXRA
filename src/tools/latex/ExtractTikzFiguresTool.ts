// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { TikzPictureManager } from '@latex/TikzPictureManager';
import {
  type ToolFileAttachment,
  type ToolResult,
} from '@shared/schemas/toolResult';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { pathToLocation } from '@utils/files/fileLocation';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  buildLimitedAttachments,
  emptyExtractionResult,
  resolveLatexFileOrThrow,
  texPathField,
} from './figureExtractionShared';

const ExtractTikzInputSchema = z.strictObject({
  texPath: texPathField('Path to the LaTeX file containing TikZ figures.'),
  compile: z
    .boolean()
    .describe('Compile extracted TikZ pictures into standalone PDFs.')
    .nullish(),
});

type ExtractTikzInput = z.infer<typeof ExtractTikzInputSchema>;

const DEFAULT_TIKZ_MAX_FILES = 12;

export class ExtractTikzFiguresTool extends defineTool({
  name: 'extract_tikz_figures',
  description:
    'Discover TikZ figures inside a LaTeX document and optionally compile them into standalone PDFs.',
  schema: ExtractTikzInputSchema,
}) {
  protected async execute({
    texPath,
    compile = true,
  }: ExtractTikzInput): Promise<ToolResult> {
    const { path, display } = await resolveLatexFileOrThrow(texPath);

    const tikzFigures = await TikzPictureManager.extract(
      pathToLocation(path.absolute),
    );
    if (tikzFigures.length === 0) {
      return emptyExtractionResult(
        'TikZ figures',
        `No TikZ figures found in ${display}.`,
      );
    }

    const formattedEntries = tikzFigures.map(
      ([label, pictures]) =>
        `- ${label ?? '(unlabeled)'}: ${formatResultCount(pictures.length, 'picture')}`,
    );
    const outputs: string[] = [
      formatToolOutput(`TikZ figures in ${display}`, formattedEntries),
    ];

    const summaryParts = [
      `Found ${formatResultCount(tikzFigures.length, 'TikZ figure')} in ${display}.`,
    ];

    let attachments: ToolFileAttachment[] | undefined;
    if (compile) {
      const compiledPaths = await TikzPictureManager.compile(
        pathToLocation(path.absolute),
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
          `Compiled ${formatResultCount(limitedPaths.length, 'standalone PDF')}.`,
        );
        outputs.push(
          formatToolOutput(
            'Compiled PDFs',
            compiledAttachments.map((file) => `- ${file.path}`),
          ),
        );
        if (limitReached) {
          summaryParts.push(
            `Limited attachments to ${formatResultCount(compiledAttachments.length, 'file')}.`,
          );
        }
      } else {
        summaryParts.push('Compilation produced no PDF outputs.');
      }
    }

    return {
      status: 'executed',
      summary: summaryParts.join(' '),
      output: outputs.join('\n'),
      files: attachments,
    };
  }
}
