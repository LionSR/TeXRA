// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';
import {
  createRunStorageLocation,
  defineTool,
  ToolContext,
  hasExtension,
  isPathWithin,
  pathToLocationIn,
} from '@texra-ai/harness';
import {
  normalizeFilePath,
  fileLocationDisplayPath,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import {
  callerRun,
  resolveToolPath,
  nullishWithDefault,
  executed,
  RunFileService,
  ToolError,
} from '@texra-ai/harness/plugins';

// Local imports

// Local file imports
import { EditorHost } from './editorHost';

const OpenPdfInputSchema = z.strictObject({
  path: z.string().describe('Path to the PDF file to open.'),
  preserve_focus: nullishWithDefault(z.boolean(), false).describe(
    'Whether the editor should preserve focus after opening.',
  ),
});

type OpenPdfInput = z.infer<typeof OpenPdfInputSchema>;

export const OpenPdfTool = defineTool({
  name: 'open_pdf',
  description:
    'Open a PDF file in the host PDF viewer. The tool accepts workspace-relative paths, working-directory-relative paths, and absolute run-storage paths.',
  schema: OpenPdfInputSchema,
  execute: Effect.fn('OpenPdfTool.call')(function* (input: OpenPdfInput) {
    const { env } = yield* ToolContext;
    const run = yield* callerRun;
    const runId = run?.runId;
    const openPdf = (yield* EditorHost).at(env.roots.storage).openPdf;
    if (!openPdf) {
      return yield* Effect.fail(
        new ToolError(
          'open_pdf is not available in this host. Open the PDF manually, or use a host that registers a PDF opener.',
        ),
      );
    }

    const trimmedPath = input.path.trim();
    if (!trimmedPath) {
      return yield* Effect.fail(new ToolError('path is required.'));
    }
    // An absolute path inside this run's own storage directory names a
    // run-storage file; anything else resolves as a tool path.
    const runDirectory =
      runId && new RunFileService(runId, env.roots).runDirectory;
    const runRelative =
      runDirectory &&
      path.isAbsolute(trimmedPath) &&
      isPathWithin(runDirectory, trimmedPath)
        ? normalizeFilePath(path.relative(runDirectory, trimmedPath))
        : '';
    const location: FileLocation =
      runId && runRelative
        ? createRunStorageLocation(trimmedPath, runRelative, runId)
        : pathToLocationIn(
            env.roots.workspace,
            (yield* resolveToolPath(env, trimmedPath)).absolute,
          );
    const displayPath = fileLocationDisplayPath(location);

    if (!hasExtension(location.absolutePath, '.pdf')) {
      return yield* Effect.fail(
        new ToolError(`open_pdf only opens PDF files: ${displayPath}`),
      );
    }
    // The path is already absolute — the resolution above produced it — so
    // the read goes through the process filesystem. A missing path, or a path
    // whose parent is not a directory, is "not found"; anything else (a
    // permission denial) is the caller's to see, as the facade's own stat was.
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(location.absolutePath).pipe(
      Effect.catchIf(
        (error) =>
          error.reason._tag === 'NotFound' ||
          error.reason._tag === 'BadResource',
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
  }),
});
