// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - tools
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { WorkspaceFs } from '@platform/rootedFs';
import type { ToolResult } from '@shared/schemas';
import { formatToolOutput } from '@tools/formatting';
import { resolveToolPath, type ToolPathCall } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { toPosixPath } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';
import { pathExists } from '@utils/files/fsDurability';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  emptyExtractionResult,
  resolveLatexFile,
  texPathField,
} from './figureExtractionShared';

const ExtractBibliographyInputSchema = z.strictObject({
  texPath: texPathField('Path to the LaTeX file to scan for citations.'),
  bibPath: z
    .string()
    .min(1, 'bibPath cannot be empty if provided.')
    .describe(
      'Optional path to a BibTeX file to include when resolving citations.',
    )
    .nullish(),
});

type ExtractBibliographyInput = z.infer<typeof ExtractBibliographyInputSchema>;

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
    ToolCall | WorkspaceFs | FileSystem.FileSystem
  > {
    const call = yield* ToolCall;
    const { path, display } = yield* resolveLatexFile(texPath);

    const context = yield* extractBibliographyContext(path.absolute);
    const bibliographyFiles = [...context.bibliographyFiles];
    const missingBibliographyFiles = [...context.missingBibliographyFiles];
    let citationKeys = [...context.citationKeys];

    // Use provided bibPath, or fall back to configured default
    const effectiveBibPath =
      bibPath || call.roots.config.get<string>('texra.bib.defaultPath');

    if (effectiveBibPath) {
      const resolved = yield* resolveToolPath(call, effectiveBibPath);
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
            call,
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
  description:
    'Collect BibTeX records for citations referenced in a LaTeX document.',
  schema: ExtractBibliographyInputSchema,
  execute: extractBibliography,
});
