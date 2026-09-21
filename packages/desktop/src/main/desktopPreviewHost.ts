import { access } from 'node:fs/promises';
import path from 'node:path';

import { Data, Effect, type FileSystem, type Path } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { isLatexFile } from '@common/files/fileTypeUtils';
import type { ExternalOpener, MessageHost } from '@hosts/uiHosts';
import { withSessionFs } from '@platform/rootedFs';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { FileLocation } from '@shared/schemas';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { createExternalLocation } from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  DESKTOP_PDF_COMMANDS,
  type DesktopShowPdfMessage,
} from '../shared/desktopPdfMessages.js';
import {
  tryShowInRenderer,
  type DesktopOverlayPostOptions,
} from './desktopIpcTypes.js';

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
  /**
   * The window shows its own "could not open" dialog and the caller reads
   * {@link PreviewUnavailable}.
   */
  openExternal(url: string): Effect.Effect<void, PreviewUnavailable>;
  /**
   * `reportFailure: false` leaves the dialog out and hands the caller the
   * shell's own rejection, the value it was thrown with — which is why that
   * form's channel is `unknown` and the default form's is not.
   */
  openExternal(
    url: string,
    options: { readonly reportFailure?: boolean },
  ): Effect.Effect<void, unknown>;
  /** Open a workspace file in the OS default application. */
  openPath(filePath: string): Effect.Effect<void, PreviewUnavailable>;
  /**
   * The build-and-show preview of one open paper: a LaTeX source compiles
   * against `roots` (its workspace, its LaTeX settings) and its PDF opens in
   * that paper's workbench.
   */
  openBuildDisplayIn(roots: WorkspaceRoots): BuildDisplayFn;
}

interface DesktopPreviewHostOptions extends DesktopOverlayPostOptions {
  shell: DesktopShellAdapter;
  showErrorMessage?: MessageHost['showErrorMessage'];
}

/**
 * A preview step that could not run: the message the desktop already showed
 * in its dialog and the rejection its caller sees. The message is the whole
 * sentence the user reads, never a prefix over another one.
 */
export class PreviewUnavailable extends Data.TaggedError('PreviewUnavailable')<{
  readonly message: string;
}> {}

export function createDesktopPreviewHost(
  options: DesktopPreviewHostOptions,
): DesktopPreviewHost {
  /**
   * Show the failure, then carry it out through the error channel. The dialog
   * is host I/O like every other call here, so a rejection from it is a typed
   * failure carrying that rejection's own text, never a fiber defect.
   */
  function fail(message: string): Effect.Effect<never, PreviewUnavailable> {
    return Effect.suspend(() =>
      options.showErrorMessage === undefined
        ? Effect.fail(new PreviewUnavailable({ message }))
        : options.showErrorMessage(message).pipe(
            Effect.catchTag('NotificationFailed', (error) =>
              Effect.fail(new PreviewUnavailable({ message: error.message })),
            ),
            Effect.flatMap(() =>
              Effect.fail(new PreviewUnavailable({ message })),
            ),
          ),
    );
  }

  function ensurePathExists(
    filePath: string,
  ): Effect.Effect<void, PreviewUnavailable> {
    return Effect.tryPromise({
      try: () => access(filePath),
      catch: (error) =>
        isFileNotFoundError(error)
          ? `File not found: ${filePath}`
          : `Cannot access file ${filePath}: ${toErrorMessage(error)}`,
    }).pipe(Effect.catch(fail));
  }

  function openPathProgram(
    filePath: string,
  ): Effect.Effect<void, PreviewUnavailable> {
    return Effect.gen(function* () {
      yield* ensurePathExists(filePath);

      const shellError = yield* Effect.tryPromise({
        try: () => options.shell.openPath(filePath),
        catch: toErrorMessage,
      }).pipe(Effect.catch((message) => Effect.succeed(message)));

      if (shellError) {
        yield* fail(`Failed to open file ${filePath}: ${shellError}`);
      }
    });
  }

  function openExternalProgram(
    url: string,
    reportFailure: boolean,
  ): Effect.Effect<void, unknown> {
    return Effect.tryPromise({
      try: () => options.shell.openExternal(url),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        reportFailure
          ? fail(`Failed to open URL ${url}: ${toErrorMessage(error)}`)
          : // The caller asked to keep the original rejection: an OAuth flow
            // decides for itself whether a missing browser handler is worth a
            // dialog.
            Effect.fail(error),
      ),
    );
  }

  /** The two forms above as one implementation: the reported one is the
   *  default, and only the unreported one carries the shell's own value. */
  function openExternal(url: string): Effect.Effect<void, PreviewUnavailable>;
  function openExternal(
    url: string,
    options: { readonly reportFailure?: boolean },
  ): Effect.Effect<void, unknown>;
  function openExternal(
    url: string,
    { reportFailure = true }: { readonly reportFailure?: boolean } = {},
  ): Effect.Effect<void, unknown> {
    return openExternalProgram(url, reportFailure);
  }

  // Opens the PDF in the renderer's pdf workbench tab (an `<iframe>` on
  // Electron's built-in Chromium viewer), or reports `false` so the caller
  // falls back to `shell.openPath`.
  function tryShowPdfInRenderer(
    roots: WorkspaceRoots,
    pdfPath: string,
    title: string,
  ): boolean {
    return tryShowInRenderer(
      { ...options, source: 'desktopPreviewHost', fallback: 'external viewer' },
      {
        command: DESKTOP_PDF_COMMANDS.SHOW_PDF,
        session: roots.storage,
        title,
        pdfPath,
      } satisfies DesktopShowPdfMessage,
    );
  }

  function buildDisplayProgram(
    roots: WorkspaceRoots,
    fileLocation: FileLocation,
  ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
      const sourcePath = fileLocation.absolutePath;
      yield* ensurePathExists(sourcePath);

      if (!isLatexFile(sourcePath)) {
        yield* openPathProgram(sourcePath);
        return;
      }

      const outputDirectory = path.dirname(sourcePath);
      const { hasLatexCompiler } = yield* Effect.promise(
        () => import('@latex/latexToolchain'),
      );
      if (!(yield* hasLatexCompiler())) {
        yield* fail(
          `No LaTeX compiler found for ${sourcePath}. Install latexmk or pdflatex to compile and preview this file.`,
        );
      }

      const { compileLatex2Pdf } = yield* Effect.promise(
        () => import('@latex/texTools'),
      );
      const built = yield* withSessionFs(
        roots,
        compileLatex2Pdf(createExternalLocation(sourcePath), roots, {
          outputDirectory,
        }),
      );
      if (!built.ok) {
        // The full engine log (up to 200 lines) goes to console.error, not the
        // dialog message -- fail() surfaces the message via a blocking native
        // `dialog.showMessageBox` modal (see main/index.ts's showErrorMessage),
        // which has no scrolling affordance and would render as an oversized,
        // unreadable dialog for a multi-hundred-line raw compiler log.
        console.error(
          `[desktop] LaTeX build failed for ${sourcePath}:\n${built.logTail}`,
        );
        yield* fail(
          `LaTeX build failed for ${sourcePath}. See the LaTeX log next to the source for details.`,
        );
        return;
      }

      // Confirm the PDF is on disk before rendering it (the iframe will
      // load nothing and present a blank surface otherwise).
      const { pdfPath } = built;
      yield* ensurePathExists(pdfPath);

      if (tryShowPdfInRenderer(roots, pdfPath, path.basename(pdfPath))) return;

      yield* openPathProgram(pdfPath);
    });
  }

  return {
    openBuildDisplayIn: (roots) => (location) =>
      buildDisplayProgram(roots, location),
    openExternal,
    openPath: openPathProgram,
  };
}
