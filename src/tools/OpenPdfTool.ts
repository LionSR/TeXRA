// Node imports
import { AsyncLocalStorage } from 'node:async_hooks';

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { currentSession } from '@agent/runtime/SessionHandle';
import { hostPort } from '@common/hostPort';
import { effectRuntime } from '@platform/processRuntime';
import {
  fileLocationDisplayPath,
  ToolError,
  type ExecutionId,
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

/**
 * The host viewer and the run coordinates path resolution needs, read from
 * the session in the caller's run context before the program runs.
 */
interface OpenPdfPorts {
  readonly openPdf: HostInteractions['openPdf'];
  /**
   * Reads the active working directory, bound to the calling turn. It stays a
   * thunk because parsing rejects a relative working directory, and an
   * absolute run-storage path must resolve without ever asking for one.
   */
  readonly toolRoot: () => string | undefined;
  readonly executionId: ExecutionId | undefined;
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
  if (!(yield* hostPort(() => AbsoluteFS.isFile(location.absolutePath)))) {
    return yield* Effect.fail(
      new ToolError(`PDF file not found: ${displayPath}`),
    );
  }

  yield* hostPort(() =>
    openPdf({
      location,
      preserveFocus: input.preserve_focus ?? false,
    }),
  );

  const message = `Opened PDF: ${displayPath}`;
  return executed(message, message);
});

export class OpenPdfTool extends defineTool({
  name: 'open_pdf',
  description:
    'Open a PDF file in the host PDF viewer. The tool accepts workspace-relative paths, working-directory-relative paths, and absolute run-storage paths.',
  schema: OpenPdfInputSchema,
}) {
  protected execute(input: OpenPdfInput): Promise<ToolResult> {
    // The session and the run it belongs to are the calling turn's, so they
    // are read here and handed to the program rather than from a fiber.
    const ports: OpenPdfPorts = {
      openPdf: currentSession().interactions.openPdf,
      toolRoot: AsyncLocalStorage.bind(currentToolRoot),
      executionId: getRunContextExecutionId(tryUseRunContext()),
    };
    return effectRuntime().runPromise(openPdfProgram(ports, input));
  }
}

const resolvePdfLocation = Effect.fn('OpenPdfTool.resolvePdfLocation')(
  function* (
    rawPath: string,
    ports: OpenPdfPorts,
  ): Effect.fn.Return<FileLocation, ToolError> {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return yield* Effect.fail(new ToolError('path is required.'));
    }

    const runStorageLocation = ports.executionId
      ? runStorageLocationFromAbsolutePath(trimmed, ports.executionId)
      : undefined;
    if (runStorageLocation) {
      return runStorageLocation;
    }

    const resolved = resolveWorkspaceRelativePath(trimmed, ports.toolRoot());
    return pathToLocation(resolved.absolute);
  },
);
