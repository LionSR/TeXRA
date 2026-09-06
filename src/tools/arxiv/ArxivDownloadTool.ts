// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ArxivProcessor, type ArxivSourceError } from '@latex/arxivProcessor';
import { effectRuntime } from '@platform/processRuntime';
import { ToolError, type ToolResult } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory, isFile } from '@utils/files/fsEntryType';
import { toPosixPath } from '@utils/core/pathCore';

const NO_ENTRIES_MESSAGE = '(no entries)';
const DEFAULT_HIDDEN_NAMES = new Set(['.git', '.gitignore']);

function formatDirEntry(name: string, type: number): string {
  if (isDirectory(type)) return `dir  ${name}/`;
  if (isFile(type)) return `file ${name}`;
  return `other ${name}`;
}

/** List the freshly-extracted source directory, skipping VCS noise. */
async function listExtractedEntries(dirFsPath: string): Promise<string> {
  const entries = await WorkspaceFS.readDir(dirFsPath);
  const dirRelative = toPosixPath(WorkspaceFS.relativePath(dirFsPath) || '.');
  const gitignore = await getGitignoreMatcher();
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
}

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

export type ArxivDownloadInput = z.infer<typeof ArxivDownloadInputSchema>;

const download = Effect.fn('ArxivDownloadTool.execute')(function* (
  input: ArxivDownloadInput,
) {
  const arxivId = input.id.trim();
  const validationError = ArxivProcessor.validateId(arxivId);
  if (validationError) {
    return yield* Effect.fail(new ToolError(validationError));
  }

  const downloadResult = yield* ArxivProcessor.downloadSource(arxivId, {
    autoIndent: input.autoIndent,
    destination: input.destination,
  }).pipe(
    Effect.mapError(
      (error: ArxivSourceError) =>
        new ToolError(`Failed to download arXiv source: ${error.message}`, {
          cause: error,
        }),
    ),
  );

  const relativePath = WorkspaceFS.relativePath(downloadResult.path) || '.';
  const displayPath = toPosixPath(relativePath);

  // A listing failure degrades to a note in the output, not a tool error:
  // the download itself already succeeded.
  const listingOutput = yield* Effect.tryPromise({
    try: () => listExtractedEntries(downloadResult.path),
    catch: (err) => err,
  }).pipe(
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

export class ArxivDownloadTool extends defineTool({
  name: 'download_arxiv_source',
  description:
    'Download an arXiv paper source archive into the workspace and list the extracted files. Use "destination" to choose where files are placed: "references" (default) saves to References/{paper_id}, "root" saves directly to the workspace root. If the source was already downloaded, it skips re-downloading and indicates that the source already exists.',
  schema: ArxivDownloadInputSchema,
}) {
  protected execute(input: ArxivDownloadInput): Promise<ToolResult> {
    // The owning agent run's cancellation enters here as interruption —
    // without it, a cancelled run would wait out the download (and its
    // retries) that only observe the internal deadline.
    return effectRuntime().runPromise(download(input), {
      signal: getCurrentToolCallContext()?.signal,
    });
  }
}
