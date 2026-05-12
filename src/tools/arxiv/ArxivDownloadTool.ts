// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { arxivProcessor } from '@latex/arxivProcessor';
import { LsTool } from '@tools/ls';
import { ToolError, type ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/formatting';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';
import { toPosixPath } from '@utils/core/pathCore';

const ArxivDownloadInputSchema = z.strictObject({
  id: z.string(),
  autoIndent: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
  destination: z
    .enum(['root', 'references'])
    .nullish()
    .transform((v) => v ?? ('references' as const)),
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
    const validationError = arxivProcessor.validateId(arxivId);
    if (validationError) {
      throw new ToolError(validationError);
    }

    let downloadResult: { path: string; alreadyExisted: boolean };
    try {
      downloadResult = await arxivProcessor.downloadSource(arxivId, {
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

    const lsTool = new LsTool();
    let listingOutput = '(directory listing unavailable)';
    try {
      const listingResult = await lsTool.call({ path: relativePath });
      if (listingResult?.output) {
        listingOutput = listingResult.output;
      } else if (listingResult?.error) {
        listingOutput = `Failed to list directory: ${listingResult.error}`;
      }
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
      summary,
      output,
    };
  }
}
