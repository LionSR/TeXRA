// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ArxivProcessor } from '@latex/arxivProcessor';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory, isFile } from '@utils/files/fsEntryType';
import { toPosixPath } from '@utils/core/pathCore';

const NO_ENTRIES_MESSAGE = '(no entries)';
const DEFAULT_HIDDEN_NAMES = new Set(['.git', '.gitignore']);

function formatDirEntry(name: string, type: number): string {
  const isDir = isDirectory(type);
  let label = 'other';
  if (isDir) label = 'dir';
  else if (isFile(type)) label = 'file';
  const suffix = isDir ? '/' : '';
  return `${label.padEnd(4)} ${name}${suffix}`;
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
  autoIndent: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true)
    .describe('Auto-indent extracted TeX files after downloading source.'),
  destination: z
    .enum(['root', 'references'])
    .nullish()
    .transform((v) => v ?? ('references' as const))
    .describe('Where to extract the source: workspace root or References/.'),
});

export type ArxivDownloadInput = z.infer<typeof ArxivDownloadInputSchema>;

export class ArxivDownloadTool extends defineTool({
  name: 'download_arxiv_source',
  description:
    'Download an arXiv paper source archive into the workspace and list the extracted files. Use "destination" to choose where files are placed: "references" (default) saves to References/{paper_id}, "root" saves directly to the workspace root. If the source was already downloaded, it skips re-downloading and indicates that the source already exists.',
  schema: ArxivDownloadInputSchema,
}) {
  protected async execute(input: ArxivDownloadInput): Promise<ToolResult> {
    const arxivId = input.id.trim();
    const validationError = ArxivProcessor.validateId(arxivId);
    if (validationError) {
      throw new ToolError(validationError);
    }

    let downloadResult: { path: string; alreadyExisted: boolean };
    try {
      downloadResult = await ArxivProcessor.downloadSource(arxivId, {
        autoIndent: input.autoIndent,
        destination: input.destination,
      });
    } catch (err) {
      throw new ToolError(
        `Failed to download arXiv source: ${toErrorMessage(err)}`,
      );
    }

    const relativePath = WorkspaceFS.relativePath(downloadResult.path) || '.';
    const displayPath = toPosixPath(relativePath);

    let listingOutput: string;
    try {
      listingOutput = await listExtractedEntries(downloadResult.path);
    } catch (err) {
      listingOutput = `Failed to list directory: ${toErrorMessage(err)}`;
    }

    const summary = downloadResult.alreadyExisted
      ? `arXiv source already downloaded at ${displayPath}`
      : `arXiv source downloaded to ${displayPath}`;
    const output = [
      summary,
      '',
      formatToolOutput(`Directory listing for ${displayPath}`, listingOutput),
    ].join('\n');

    return {
      status: 'executed',
      summary,
      output,
    };
  }
}
