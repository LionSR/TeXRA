// Third-party imports
import { z } from 'zod';

// Local imports
import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type { FileLocation } from '@shared/schemas';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import {
  currentToolRoot,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import {
  AbsoluteFS,
  pathToLocation,
  runStorageLocationFromAbsolutePath,
} from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';

// Local file imports
import { defineTool } from './core/define';

export interface OpenPdfRequest {
  readonly location: FileLocation;
  readonly preserveFocus: boolean;
}

export type OpenPdfOpener = (request: OpenPdfRequest) => Promise<void> | void;

let openPdfOpener: OpenPdfOpener | undefined;

/** Register the host-specific PDF opener. Leave unset in non-UI hosts. */
export function setOpenPdfOpener(opener: OpenPdfOpener | undefined): void {
  openPdfOpener = opener;
}

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
    if (!openPdfOpener) {
      return {
        status: 'error',
        error:
          'open_pdf is not available in this host. Open the PDF manually, or use a host that registers a PDF opener.',
      };
    }

    const location = resolvePdfLocation(input.path);
    const displayPath = displayPdfLocation(location);

    if (!hasExtension(location.absolutePath, '.pdf')) {
      throw new ToolError(`open_pdf only opens PDF files: ${displayPath}`);
    }
    if (!(await AbsoluteFS.isFile(location.absolutePath))) {
      throw new ToolError(`PDF file not found: ${displayPath}`);
    }

    await openPdfOpener({
      location,
      preserveFocus: input.preserve_focus ?? false,
    });

    return {
      status: 'executed',
      summary: `Opened PDF: ${displayPath}`,
      output: `Opened PDF: ${displayPath}`,
    };
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

  const root = currentToolRoot();
  const resolved = resolveWorkspaceRelativePath(trimmed, root);
  return pathToLocation(resolved.absolute);
}

function displayPdfLocation(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return location.absolutePath;
}
