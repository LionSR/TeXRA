// Third-party imports
import { formatResultCount } from '@texra-ai/harness/transcript';
import { Effect, FileSystem, Schema } from 'effect';
import {
  defineTool,
  ToolContext,
  type ToolResult,
  pathToLocationIn,
} from '@texra-ai/harness';

// Local imports - tools
import { resolveToolPath, formatToolOutput } from '@texra-ai/harness/plugins';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';

import {
  buildLimitedAttachments,
  emptyExtractionResult,
  resolveLatexFile,
  texPathField,
} from './figureExtractionShared';

const ExtractFiguresInputSchema = Schema.Struct({
  texPath: texPathField('Path to the primary LaTeX file to inspect.'),
});

type ExtractFiguresInput = typeof ExtractFiguresInputSchema.Type;

const DEFAULT_MAX_FILES = 20;

const extractFigures = Effect.fn('ExtractLatexFiguresTool.execute')(function* ({
  texPath,
}: ExtractFiguresInput): Effect.fn.Return<
  ToolResult,
  Error,
  ToolContext | FileSystem.FileSystem
> {
  const call = yield* ToolContext;
  const { path, display } = yield* resolveLatexFile(texPath);

  // Already de-duplicated by the extractor.
  const uniqueFigures = yield* extractFigurePathsFromLatex(
    pathToLocationIn(call.env.roots.workspace, path.absolute),
  );

  if (uniqueFigures.length === 0) {
    return emptyExtractionResult('Figures', `No figures found in ${display}.`);
  }

  const { attachments, limitedPaths, limitReached } =
    yield* buildLimitedAttachments(uniqueFigures, {
      limit: DEFAULT_MAX_FILES,
      describe: () => `Figure referenced by ${display}`,
    });

  const formattedList = yield* Effect.forEach(limitedPaths, (figurePath) =>
    Effect.map(
      resolveToolPath(call.env, figurePath),
      ({ display: figureDisplay }) => `- ${figureDisplay}`,
    ),
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

export const ExtractLatexFiguresTool = defineTool({
  name: 'extract_figures',
  replay: 'safe',
  description:
    'Resolve and list figure assets referenced by a LaTeX document, returning attachments when available.',
  schema: ExtractFiguresInputSchema,
  execute: extractFigures,
});
