// Third-party imports
import { z } from 'zod';

// Local imports
import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { currentSession } from '@agent/runtime/SessionHandle';
import {
  fileLocationDisplayPath,
  ToolError,
  type FileLocation,
  type ToolResult,
} from '@shared/schemas';
import {
  currentToolRoot,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { runStorageLocationFromAbsolutePath } from '@utils/files/runStorageFs';
import { hasExtension } from '@utils/core/pathCore';

// Local file imports
import { defineTool } from './core/define';

const OpenPdfInputSchema = z.strictObject({
  path: z.string().describe('Path to the PDF file to open.'),
  preserve_focus: z
    .boolean()
    .nullish()
    .describe('Whether the editor should preserve focus after opening.'),
});

export type OpenPdfInput = z.infer<typeof OpenPdfInputSchema>;

export class OpenPdfTool extends defineTool({
  name: 'open_pdf',
  description:
    'Open a PDF file in the host PDF viewer. The tool accepts workspace-relative paths, working-directory-relative paths, and absolute run-storage paths.',
  schema: OpenPdfInputSchema,
}) {
  protected async execute(input: OpenPdfInput): Promise<ToolResult> {
    const openPdf = currentSession().interactions.openPdf;
    if (!openPdf) {
      throw new ToolError(
        'open_pdf is not available in this host. Open the PDF manually, or use a host that registers a PDF opener.',
      );
    }

    const location = resolvePdfLocation(input.path);
    const displayPath = fileLocationDisplayPath(location);

    if (!hasExtension(location.absolutePath, '.pdf')) {
      throw new ToolError(`open_pdf only opens PDF files: ${displayPath}`);
    }
    if (!(await AbsoluteFS.isFile(location.absolutePath))) {
      throw new ToolError(`PDF file not found: ${displayPath}`);
    }

    await openPdf({
      location,
      preserveFocus: input.preserve_focus ?? false,
    });

    const message = `Opened PDF: ${displayPath}`;
    return executed(message, message);
  }
}

function resolvePdfLocation(rawPath: string): FileLocation {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new ToolError('path is required.');
  }

  const executionId = getRunContextExecutionId(tryUseRunContext());
  const runStorageLocation = executionId
    ? runStorageLocationFromAbsolutePath(trimmed, executionId)
    : undefined;
  if (runStorageLocation) {
    return runStorageLocation;
  }

  const resolved = resolveWorkspaceRelativePath(trimmed, currentToolRoot());
  return pathToLocation(resolved.absolute);
}
