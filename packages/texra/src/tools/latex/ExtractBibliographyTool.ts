// Node imports
import * as nodePath from 'node:path';
import { formatResultCount } from '@texra-ai/harness/transcript';

// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';
import { defineTool, type ToolResult } from '@texra-ai/harness';
import { ToolContext } from '@texra-ai/harness/plugins';
import { Settings, WorkspaceFs, toPosixPath } from '@texra-ai/harness/host';
import { relativeToRoot, pathExists } from '@texra-ai/harness/node';

// Local imports - tools
import { ensureError } from '@texra-ai/harness/schemas';
import {
  resolveToolPath,
  type ToolPathCall,
  executed,
  formatToolOutput,
} from '@texra-ai/harness/plugins';
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';
import {
  emptyExtractionResult,
  resolveLatexFile,
  texPathField,
} from './figureExtractionShared';

const ExtractBibliographyInputSchema = Schema.Struct({
  texPath: texPathField('Path to the LaTeX file to scan for citations.'),
  bibPath: Schema.optional(
    Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          'Optional path to a BibTeX file to include when resolving citations.',
      }),
    ),
  ),
});

type ExtractBibliographyInput = typeof ExtractBibliographyInputSchema.Type;

const DEFAULT_MAX_ENTRIES = 25;

/**
 * Display already-resolved absolute paths: relative to the working directory
 * (or the workspace) when they lie under it, absolute otherwise. These are
 * files the document names, not tool input, so no containment applies: a
 * chapter run's missing `../refs.bib` is a note, not a tool failure.
 */
function formatPathList(call: ToolPathCall, filePaths: string[]) {
  const base = call.workingDirectory ?? call.roots.workspace;
  return Effect.try({
    try: () =>
      filePaths
        .map((filePath) =>
          toPosixPath(
            (base === undefined ? undefined : relativeToRoot(base, filePath)) ??
              filePath,
          ),
        )
        .join(', '),
    catch: ensureError,
  });
}

const extractBibliography = Effect.fn('ExtractBibliographyTool.execute')(
  function* ({
    texPath,
    bibPath,
  }: ExtractBibliographyInput): Effect.fn.Return<
    ToolResult,
    Error,
    ToolContext | WorkspaceFs | FileSystem.FileSystem
  > {
    const call = yield* ToolContext;
    const { path, display } = yield* resolveLatexFile(texPath);

    const context = yield* extractBibliographyContext(path.absolute);
    const bibliographyFiles = [...context.bibliographyFiles];
    const missingBibliographyFiles = [...context.missingBibliographyFiles];
    let citationKeys = [...context.citationKeys];

    // Use provided bibPath, or fall back to configured default
    const effectiveBibPath =
      bibPath ||
      (yield* Settings.get<string>(call.env.roots, 'texra.bib.defaultPath'));

    if (effectiveBibPath) {
      const resolved = yield* resolveToolPath(call.env, effectiveBibPath);
      // `fsPath` records where the bibliography landed: workspace-relative
      // inside the session's folder, absolute for a path the caller chose
      // outside it. So the confined `WorkspaceFs` view of this call's own
      // workspace answers the first and the process `FileSystem` the second.
      const fs: FileSystem.FileSystem = nodePath.isAbsolute(resolved.fsPath)
        ? yield* FileSystem.FileSystem
        : yield* WorkspaceFs;
      // A path whose parent is not a directory is a missing bibliography, not
      // a tool failure: that is `pathExists`'s reading. `exists` follows the
      // link, deliberately, so a dangling symlink reads as a missing
      // bibliography.
      const exists = yield* pathExists(fs, resolved.fsPath);
      const target = exists ? bibliographyFiles : missingBibliographyFiles;
      if (!target.includes(resolved.absolute)) {
        target.push(resolved.absolute);
      }
      if (citationKeys.length === 0) {
        citationKeys = ['*'];
      }
    }

    const missingBibliographyNote =
      missingBibliographyFiles.length > 0
        ? `Missing bibliography files: ${yield* formatPathList(
            call.env,
            missingBibliographyFiles,
          )}.`
        : undefined;

    if (
      citationKeys.length === 0 &&
      bibliographyFiles.length === 0 &&
      missingBibliographyFiles.length === 0
    ) {
      return emptyExtractionResult(
        `BibTeX entries in ${display}`,
        `No citations or bibliography directives found in ${display}.`,
      );
    }

    if (citationKeys.length === 0) {
      const missingNote = missingBibliographyNote
        ? `\n\nNote: ${missingBibliographyNote}`
        : '';
      const result = emptyExtractionResult(
        `BibTeX entries in ${display}`,
        `No citation commands found in ${display}.`,
      );
      return { ...result, output: `${result.output}${missingNote}` };
    }

    const { entries, missingKeys } = yield* loadBibliographyEntries(
      bibliographyFiles,
      citationKeys,
    );

    const entryLines = summarizeBibliographyEntries(
      entries,
      DEFAULT_MAX_ENTRIES,
    );
    const output = formatToolOutput(
      `BibTeX entries cited in ${display}`,
      entryLines,
      'No matching entries found.',
    );

    const entryCount = entries.size;
    const citationKeyCount = formatResultCount(
      citationKeys.length,
      'citation key',
    );

    const summary =
      entryCount === 0
        ? `No matching bibliography entries found for ${citationKeyCount} in ${display}.`
        : `Resolved ${formatResultCount(entryCount, 'bibliography entry', 'bibliography entries')} for ${citationKeyCount} in ${display}.`;

    const instructions = [
      missingBibliographyNote,
      missingKeys.length > 0 &&
        `Missing citation keys: ${missingKeys.map((k) => `\`${k}\``).join(', ')}.`,
      entryCount > DEFAULT_MAX_ENTRIES &&
        `Limited output to ${DEFAULT_MAX_ENTRIES} entries.`,
    ].filter((x): x is string => Boolean(x));

    const notes =
      instructions.length > 0 ? `\n\nNote: ${instructions.join(' ')}` : '';

    return executed(`${output}${notes}`, summary);
  },
);

export const ExtractBibliographyTool = defineTool({
  name: 'extract_bib_entries',
  replay: 'safe',
  description:
    'Collect BibTeX records for citations referenced in a LaTeX document.',
  schema: ExtractBibliographyInputSchema,
  execute: extractBibliography,
});
