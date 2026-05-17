// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - runtime
import { tryUseRunContext } from '@agent/runtime/RunContext';

// Type imports
import type { FileLocation } from '@shared/schemas';

// Local imports - tools
import {
  currentToolRoot,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { ToolError, type ToolResult } from '@tools/result';

// Local imports - utilities
import {
  AbsoluteFS,
  createRunStorageLocation,
  getRunDir,
  pathToLocation,
} from '@utils/files';

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
        isError: true,
        error:
          'open_pdf is not available in this host. Open the PDF manually, or use a host that registers a PDF opener.',
      };
    }

    const location = resolvePdfLocation(input.path);
    const displayPath = displayPdfLocation(location);

    if (path.extname(location.absolutePath).toLowerCase() !== '.pdf') {
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

  const runStorageLocation = resolveRunStorageLocation(trimmed);
  if (runStorageLocation) {
    return runStorageLocation;
  }

  const root = currentToolRoot();
  const resolved = resolveWorkspaceRelativePath(trimmed, root);
  return pathToLocation(resolved.absolute);
}

function resolveRunStorageLocation(rawPath: string): FileLocation | undefined {
  if (!path.isAbsolute(rawPath)) return undefined;

  const executionId = tryUseRunContext()?.executionId;
  if (!executionId) return undefined;

  const runDirectory = getRunDir(executionId);
  const relativePath = path
    .relative(runDirectory, rawPath)
    .replaceAll('\\', '/');
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath === ''
  ) {
    return undefined;
  }

  return createRunStorageLocation(rawPath, relativePath, executionId);
}

function displayPdfLocation(location: FileLocation): string {
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath;
  }
  return location.absolutePath;
}
