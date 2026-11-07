import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Effect,
  FileSystem,
  type Path,
  type PlatformError,
  Schema,
} from 'effect';

import {
  type ProcessRuntime,
  withLogChannel,
  withProcessServices,
  withSessionFs,
} from '@texra-ai/harness/host';
import { absentReason } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { isLatexFile } from '@texra/shared/latexFileTypes';
import { HostFailed } from '@texra/hosts/uiHosts';
import type { BuildDisplayFn } from '@texra/tools/latex/latexPreview';

import {
  DESKTOP_PDF_COMMANDS,
  type DesktopShowPdfMessage,
} from '../shared/desktopPdfMessages.js';
import type { DesktopRenderer } from './desktopIpcTypes.js';
import type { FileLocation } from '@texra-ai/harness/schemas';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

interface DesktopShellAdapter {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
}

/**
 * The desktop's shell-facing open surface. `openExternal` and `openPath` are
 * the programs themselves: the owner ruling of 2026-09-18 retires the former
 * `Promise` face, which the 1.0 clean rule reads as an R1 adapter rather than
 * the permanent one an earlier ruling allowed. An Effect-native caller yields
 * a member; the host entries that answer a framework callback run it once.
 *
 * `openBuildDisplayIn` answers with the core {@link BuildDisplayFn}, a
 * program like the rest: the approval controller forks it onto a fiber of its
 * own so a build outlives the preview program whose settle race interrupts it.
 */
interface DesktopPreviewHost {
  /** Open a URL in the default browser. The shell's rejection is
   *  {@link HostFailed}; the caller presents it. */
  openExternal(url: string): Effect.Effect<void, HostFailed>;
  /** Open a workspace file in the OS default application. */
  openPath(filePath: string): Effect.Effect<void, PreviewUnavailable>;
  /**
   * The build-and-show preview of one open paper: a LaTeX source compiles
   * against `roots` (its workspace, its LaTeX settings) and its PDF opens in
   * that paper's workbench.
   */
  openBuildDisplayIn(roots: WorkspaceRoots): BuildDisplayFn;
}

interface DesktopPreviewHostOptions extends DesktopRenderer {
  shell: DesktopShellAdapter;
  /** The process runtime the window was handed. It only supplies the
   *  filesystem `openPath` probes through; nothing settles on it. */
  runtime: ProcessRuntime;
}

/**
 * A preview step that could not run, which its caller presents. The message
 * is the whole sentence the user reads, never a prefix over another one.
 */
export class PreviewUnavailable extends Schema.TaggedError<PreviewUnavailable>()(
  'PreviewUnavailable',
  {
    message: Schema.String,
  },
) {}

export function createDesktopPreviewHost(
  options: DesktopPreviewHostOptions,
): DesktopPreviewHost {
  /** The builds this host has shown: each tab reload names the newest. */
  let builds = 0;
  const fail = (message: string): Effect.Effect<never, PreviewUnavailable> =>
    Effect.fail(new PreviewUnavailable({ message }));

  function ensurePathExists(
    filePath: string,
  ): Effect.Effect<void, PreviewUnavailable, FileSystem.FileSystem> {
    return FileSystem.FileSystem.use((fs) => fs.access(filePath)).pipe(
      Effect.catch((error: PlatformError.PlatformError) =>
        fail(
          absentReason(error)
            ? `File not found: ${filePath}`
            : `Cannot access file ${filePath}: ${toErrorMessage(error.reason.cause ?? error)}`,
        ),
      ),
    );
  }

  const openPathProgram = Effect.fn('openPathProgram')(function* (
    filePath: string,
  ): Effect.fn.Return<void, PreviewUnavailable, FileSystem.FileSystem> {
    yield* ensurePathExists(filePath);

    const shellError = yield* Effect.tryPromise({
      try: () => options.shell.openPath(filePath),
      catch: toErrorMessage,
    }).pipe(Effect.catch((message) => Effect.succeed(message)));

    if (shellError) {
      yield* fail(`Failed to open file ${filePath}: ${shellError}`);
    }
  });

  const openExternal = (url: string): Effect.Effect<void, HostFailed> =>
    Effect.tryPromise({
      try: () => options.shell.openExternal(url),
      catch: (cause) =>
        new HostFailed({
          member: 'openExternal',
          message: `The desktop could not open ${url} in the default browser: ${toErrorMessage(cause)}`,
          cause,
        }),
    });

  const buildDisplayProgram = Effect.fn('buildDisplayProgram')(function* (
    roots: WorkspaceRoots,
    fileLocation: FileLocation,
  ): Effect.fn.Return<
    void,
    PreviewUnavailable,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const sourcePath = fileLocation.absolutePath;
    yield* ensurePathExists(sourcePath);

    if (!isLatexFile(sourcePath)) {
      yield* openPathProgram(sourcePath);
      return;
    }

    const outputDirectory = path.dirname(sourcePath);
    const { compileLatex2Pdf } = yield* Effect.promise(
      () => import('@latex/texTools'),
    );
    const built = yield* withSessionFs(
      roots,
      compileLatex2Pdf({ kind: 'external', absolutePath: sourcePath }, roots, {
        outputDirectory,
      }),
    ).pipe(
      // No compiler to drive: the message names it and how to install one.
      Effect.catchTag('ToolMissing', (missing) =>
        fail(`Cannot preview ${sourcePath}: ${missing.message}`),
      ),
    );
    if (!built.ok) {
      // The full engine log (up to 200 lines) goes to the app log, not the
      // failure's message -- its caller presents it in a blocking native
      // `dialog.showMessageBox` modal (desktopWindowHost.ts's `presented`),
      // which has no scrolling affordance and would render as an oversized,
      // unreadable dialog for a multi-hundred-line raw compiler log.
      // In the message, not a `data` annotation: the sink bounds an
      // annotation to 2000 characters, and the tail runs to 200 lines.
      yield* Effect.logError(
        `LaTeX build failed for ${sourcePath}:\n${built.logTail}`,
      ).pipe(withLogChannel('desktop'));
      yield* fail(
        `LaTeX build failed for ${sourcePath}. See the LaTeX log next to the source for details.`,
      );
      return;
    }

    // A successful build names a PDF on disk. Every build gets its own
    // number, so its tab reloads however close in time two builds land.
    // It opens in the renderer's pdf workbench tab (an `<iframe>` on
    // Electron's built-in Chromium viewer).
    const { pdfPath } = built;
    options.postToRenderer({
      command: DESKTOP_PDF_COMMANDS.SHOW_PDF,
      session: roots.storage,
      title: path.basename(pdfPath),
      pdfUrl: pathToFileURL(pdfPath).href,
      build: ++builds,
    } satisfies DesktopShowPdfMessage);
  });

  return {
    openBuildDisplayIn: (roots) => (location) =>
      buildDisplayProgram(roots, location),
    openExternal,
    openPath: (filePath) =>
      withProcessServices(options.runtime, openPathProgram(filePath)),
  };
}
