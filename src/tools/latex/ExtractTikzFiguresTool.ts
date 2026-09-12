// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - tools
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { type ToolFileAttachment, type ToolResult } from '@shared/schemas';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { ensureError } from '@utils/errors/errorMessage';
import { pathToLocation } from '@utils/files/fileLocation';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  buildLimitedAttachments,
  emptyExtractionResult,
  resolveLatexFile,
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

const extractTikzFigures = Effect.fn('ExtractTikzFiguresTool.execute')(
  function* ({
    texPath,
    compile = true,
  }: ExtractTikzInput): Effect.fn.Return<ToolResult, Error, ToolCall> {
    const call = yield* ToolCall;
    const { path, display } = yield* resolveLatexFile(texPath);
    const location = pathToLocation(path.absolute);

    const tikzFigures = yield* Effect.tryPromise({
      try: () => call.inScope(() => TikzPictureManager.extract(location)),
      catch: ensureError,
    });
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
      const compiledPaths = yield* Effect.tryPromise({
        try: () => call.inScope(() => TikzPictureManager.compile(location)),
        catch: ensureError,
      });
      if (compiledPaths.length > 0) {
        // Convert FileLocation[] to string[] for legacy attachment API
        const compiledPathStrings = compiledPaths.map(
          (loc) => loc.absolutePath,
        );
        const { attachments: compiledAttachments, limitReached } =
          yield* buildLimitedAttachments(compiledPathStrings, {
            limit: DEFAULT_TIKZ_MAX_FILES,
            describe: () => `Standalone TikZ figure derived from ${display}`,
            mimeType: 'application/pdf',
          });
        attachments = compiledAttachments;
        summaryParts.push(
          `Compiled ${formatResultCount(compiledPathStrings.length, 'standalone PDF')}.`,
        );
        outputs.push(
          formatToolOutput(
            'Compiled PDFs',
            compiledAttachments.map((file) => `- ${file.path}`),
          ),
        );
        if (limitReached) {
          summaryParts.push(
            `Limited attachments to ${compiledAttachments.length} of ${compiledPathStrings.length} files.`,
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
  },
);

export class ExtractTikzFiguresTool extends defineTool({
  name: 'extract_tikz_figures',
  description:
    'Discover TikZ figures inside a LaTeX document and optionally compile them into standalone PDFs.',
  schema: ExtractTikzInputSchema,
}) {
  protected execute(input: ExtractTikzInput) {
    return extractTikzFigures(input);
  }
}
