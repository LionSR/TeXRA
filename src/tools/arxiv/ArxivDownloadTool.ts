// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { LsTool } from '@tools/ls';
import { ToolError, ToolResult } from '@tools/result';
import { formatToolOutput } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { toPosixPath } from '@utils/core';
import { WorkspaceFS } from '@utils/files';
import { arxivProcessor } from '@latex/arxivProcessor';

const ArxivDownloadInputSchema = z.strictObject({
  id: z.string(),
  autoIndent: z.boolean().nullish(),
});

export type ArxivDownloadInput = z.infer<typeof ArxivDownloadInputSchema>;

const validateArxivId = (id: string): string | null =>
  arxivProcessor.validateId(id);

export class ArxivDownloadTool extends defineTool({
  name: 'download_arxiv_source',
  description:
    'Download an arXiv paper source archive into the workspace and list the extracted files.',
  schema: ArxivDownloadInputSchema,
}) {
  protected async execute(input: ArxivDownloadInput): Promise<ToolResult> {
    const arxivId = input.id.trim();
    const validationError = validateArxivId(arxivId);
    if (validationError) {
      throw new ToolError(validationError);
    }

    let downloadPath: string;
    try {
      downloadPath = await arxivProcessor.downloadSource(
        arxivId,
        undefined,
        input.autoIndent ?? true,
      );
    } catch (err) {
      throw new ToolError(
        `Failed to download arXiv source: ${toErrorMessage(err)}`,
      );
    }

    const relativeRaw = WorkspaceFS.relativePath(downloadPath);
    // WorkspaceFS.relativePath returns an empty string for the workspace root; normalise to '.' for tooling.
    const relativePath = relativeRaw === '' ? '.' : relativeRaw;
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

    const summary = `Downloaded arXiv source to ${displayPath}`;
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
