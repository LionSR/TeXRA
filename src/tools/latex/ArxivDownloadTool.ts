// Third-party imports
import { z } from 'zod';

// Local imports - latex
import { arxivProcessor } from '@latex/arxivProcessor';

// Local imports - tools
import { defineTool } from '../core/define';
import { LsTool } from '@tools/ls';
import { ToolError, ToolResult, toolResult } from '@tools/result';
import { formatToolOutput, toPosixPath } from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const ArxivDownloadInputSchema = z.strictObject({
  id: z.string(),
  autoIndent: z.boolean().optional(),
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
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolError(`Failed to download arXiv source: ${message}`);
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
      const message = err instanceof Error ? err.message : String(err);
      listingOutput = `Failed to list directory: ${message}`;
    }

    const summary = `Downloaded arXiv source to ${displayPath}`;
    const output = [
      summary,
      '',
      formatToolOutput(`Directory listing for ${displayPath}`, listingOutput),
    ].join('\n');

    return toolResult({
      summary,
      output,
    });
  }
}
