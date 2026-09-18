import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Path } from 'effect';
import { z } from 'zod';

// Local imports
import { ToolCall } from '@agent/runtime/ToolCall';
import { ArxivProcessor, type ArxivSourceError } from '@latex/arxivProcessor';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readDirectoryTyped } from '@utils/files/fsDurability';
import { toPosixPath } from '@utils/core/pathCore';

const NO_ENTRIES_MESSAGE = '(no entries)';
const DEFAULT_HIDDEN_NAMES = new Set(['.git', '.gitignore']);

function formatDirEntry(name: string, type: FileSystem.File.Type): string {
  if (type === 'Directory') return `dir  ${name}/`;
  if (type === 'File') return `file ${name}`;
  return `other ${name}`;
}

/** List the freshly-extracted source directory, skipping VCS noise. */
const listExtractedEntries = Effect.fn('listExtractedEntries')(function* (
  dirFsPath: string,
  workspaceRoot: string,
): Effect.fn.Return<string, unknown, FileSystem.FileSystem | Path.Path> {
  // The extraction directory is already absolute, so it is listed through the
  // process filesystem; each entry carries its own type, a symlink reported
  // as a symlink rather than as what it points at.
  const entries = yield* readDirectoryTyped(dirFsPath);
  const dirRelative = toPosixPath(
    path.relative(workspaceRoot, dirFsPath) || '.',
  );
  const gitignore = yield* getGitignoreMatcher(workspaceRoot);
  const formatted = entries
    .filter(([name]) => {
      if (DEFAULT_HIDDEN_NAMES.has(name)) return false;
      const childRelative =
        dirRelative === '.' ? name : `${dirRelative}/${name}`;
      return !gitignore.ignores(childRelative);
    })
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, type]) => formatDirEntry(name, type));
  return formatted.length > 0 ? formatted.join('\n') : NO_ENTRIES_MESSAGE;
});

const ArxivDownloadInputSchema = z.strictObject({
  id: z.string().describe('arXiv identifier or URL for the source archive.'),
  autoIndent: nullishWithDefault(z.boolean(), true).describe(
    'Auto-indent extracted TeX files after downloading source.',
  ),
  destination: nullishWithDefault(
    z.enum(['root', 'references']),
    'references',
  ).describe('Where to extract the source: workspace root or References/.'),
});

type ArxivDownloadInput = z.infer<typeof ArxivDownloadInputSchema>;

const download = Effect.fn('ArxivDownloadTool.execute')(function* (
  input: ArxivDownloadInput,
) {
  const call = yield* ToolCall;
  const workspaceRoot = (yield* WorkspaceFs).root ?? '';
  const arxivId = input.id.trim();
  const validationError = ArxivProcessor.validateId(arxivId);
  if (validationError) {
    return yield* Effect.fail(new ToolError(validationError));
  }

  const downloadResult = yield* ArxivProcessor.downloadSource(arxivId, {
    workspaceRoot,
    formatter: input.autoIndent ? resolveLatexFormatter(call.roots) : null,
    autoIndent: input.autoIndent,
    destination: input.destination,
  }).pipe(
    Effect.catch((error: ArxivSourceError) =>
      Effect.fail(
        new ToolError(`Failed to download arXiv source: ${error.message}`, {
          cause: error,
        }),
      ),
    ),
  );

  const relativePath = path.relative(workspaceRoot, downloadResult.path) || '.';
  const displayPath = toPosixPath(relativePath);

  // A listing failure degrades to a note in the output, not a tool error:
  // the download itself already succeeded.
  const listingOutput = yield* listExtractedEntries(
    downloadResult.path,
    workspaceRoot,
  ).pipe(
    Effect.catch((err) =>
      Effect.succeed(`Failed to list directory: ${toErrorMessage(err)}`),
    ),
  );

  const summary = downloadResult.alreadyExisted
    ? `arXiv source already downloaded at ${displayPath}`
    : `arXiv source downloaded to ${displayPath}`;
  const output = [
    summary,
    '',
    formatToolOutput(`Directory listing for ${displayPath}`, listingOutput),
  ].join('\n');

  return executed(output, summary);
});

export const ArxivDownloadTool = defineTool({
  name: 'download_arxiv_source',
  description:
    'Download an arXiv paper source archive into the workspace and list the extracted files. Use "destination" to choose where files are placed: "references" (default) saves to References/{paper_id}, "root" saves directly to the workspace root. If the source was already downloaded, it skips re-downloading and indicates that the source already exists.',
  schema: ArxivDownloadInputSchema,
  // The owning agent run's cancellation enters here as interruption —
  // without it, a cancelled run would wait out the download (and its
  // retries) that only observe the internal deadline.
  execute: download,
});
