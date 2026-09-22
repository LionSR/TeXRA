// Node imports

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import {
  fileLocationDisplayPath,
  ToolError,
  type FileLocation,
  type RunStorageFileLocation,
} from '@shared/schemas';
import {
  resolveWorkspaceRelativePath,
  workspacePathPorts,
  type WorkspacePathPorts,
} from '@tools/pathResolution';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { runStorageLocationInRunUnder } from '@utils/files/runStorageFs';
import { hasExtension } from '@utils/core/pathCore';

// Local file imports
import { defineTool } from './core/define';

const OpenPdfInputSchema = z.strictObject({
  path: z.string().describe('Path to the PDF file to open.'),
  preserve_focus: nullishWithDefault(z.boolean(), false).describe(
    'Whether the editor should preserve focus after opening.',
  ),
});

export type OpenPdfInput = z.infer<typeof OpenPdfInputSchema>;

/**
 * The host viewer and the run coordinates path resolution needs, read from
 * the session in the caller's run context before the program runs.
 */
interface OpenPdfPorts extends WorkspacePathPorts {
  readonly openPdf: HostInteractions['openPdf'];
  /**
   * The requested path's run-storage identity, resolved in the caller's turn
   * against the run's own storage root (`session.roots.storage`), which the
   * caller holds as data. Undefined when this run has no storage of its own
   * or the path lies outside it.
   */
  readonly runStorageLocation: RunStorageFileLocation | undefined;
}

const openPdfProgram = Effect.fn('OpenPdfTool.execute')(function* (
  ports: OpenPdfPorts,
  input: OpenPdfInput,
) {
  const openPdf = ports.openPdf;
  if (!openPdf) {
    return yield* Effect.fail(
      new ToolError(
        'open_pdf is not available in this host. Open the PDF manually, or use a host that registers a PDF opener.',
      ),
    );
  }

  const location = yield* resolvePdfLocation(input.path, ports);
  const displayPath = fileLocationDisplayPath(location);

  if (!hasExtension(location.absolutePath, '.pdf')) {
    return yield* Effect.fail(
      new ToolError(`open_pdf only opens PDF files: ${displayPath}`),
    );
  }
  // The path is already absolute — the resolution above produced it — so the
  // read goes through the process filesystem. A missing path, or a path whose
  // parent is not a directory, is "not found"; anything else (a permission
  // denial) is the caller's to see, as the facade's own stat was.
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(location.absolutePath).pipe(
    Effect.catchIf(
      (error) =>
        error.reason._tag === 'NotFound' || error.reason._tag === 'BadResource',
      () => Effect.succeed(undefined),
    ),
  );
  if (info?.type !== 'File') {
    return yield* Effect.fail(
      new ToolError(`PDF file not found: ${displayPath}`),
    );
  }

  // The host viewer's own failure, matched by tag: the agent is told the
  // viewer refused rather than seeing an unknown rejection escape the tool.
  yield* openPdf({
    location,
    preserveFocus: input.preserve_focus,
  }).pipe(
    Effect.catchTag('PdfOpenFailed', (error) =>
      Effect.fail(
        new ToolError(`Failed to open PDF ${displayPath}: ${error.message}`),
      ),
    ),
  );

  const message = `Opened PDF: ${displayPath}`;
  return executed(message, message);
});

export const OpenPdfTool = defineTool({
  name: 'open_pdf',
  description:
    'Open a PDF file in the host PDF viewer. The tool accepts workspace-relative paths, working-directory-relative paths, and absolute run-storage paths.',
  schema: OpenPdfInputSchema,
  execute: Effect.fn('OpenPdfTool.call')(function* (input: OpenPdfInput) {
    const call = yield* ToolCall;
    const runId = call.run?.runId;
    const trimmedPath = input.path.trim();
    const ports: OpenPdfPorts = {
      ...workspacePathPorts(call),
      openPdf: call.run?.session.interactions.openPdf,
      runStorageLocation:
        runId && trimmedPath
          ? runStorageLocationInRunUnder(call.roots.storage, trimmedPath, runId)
          : undefined,
    };
    return yield* openPdfProgram(ports, input);
  }),
});

const resolvePdfLocation = Effect.fn('OpenPdfTool.resolvePdfLocation')(
  function* (
    rawPath: string,
    ports: OpenPdfPorts,
  ): Effect.fn.Return<FileLocation, ToolError> {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return yield* Effect.fail(new ToolError('path is required.'));
    }

    if (ports.runStorageLocation) {
      return ports.runStorageLocation;
    }

    const resolved = yield* resolveWorkspaceRelativePath(
      ports.settings,
      ports.workspaceRoot,
      trimmed,
      ports.toolRoot(),
    );
    return pathToLocationIn(ports.workspaceRoot, resolved.absolute);
  },
);
