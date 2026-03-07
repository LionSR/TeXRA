// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { arxivProcessor } from '@latex/arxivProcessor';
import { LsTool } from '@tools/ls';
import { ToolError, ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';
import { toPosixPath } from '@utils/core/pathCore';

const ArxivDownloadInputSchema = z.strictObject({
  id: z.string(),
  autoIndent: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
});

export type ArxivDownloadInput = z.infer<typeof ArxivDownloadInputSchema>;

export class ArxivDownloadTool extends defineTool({
  name: 'download_arxiv_source',
  description:
    'Download an arXiv paper source archive into the workspace and list the extracted files. If the source was already downloaded, it skips re-downloading and indicates that the source already exists.',
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
      downloadResult = await arxivProcessor.downloadSource(
        arxivId,
        undefined,
        input.autoIndent,
      );
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
