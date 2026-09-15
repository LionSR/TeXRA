import { access } from 'node:fs/promises';
import path from 'node:path';

import { Data, Effect } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { isLatexFile } from '@common/files/fileTypeUtils';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
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
 * The desktop's shell-facing open surface. It deliberately stays
 * `Promise`-shaped — this fan-out is bound across the desktop's browser-view,
 * shell, settings, tooling and credential surfaces, a permanent face by owner
 * ruling — and the composition root adapts `openExternal` onto the
 * Effect-typed `ExternalOpener` port where an Effect-native caller needs it.
 */
interface DesktopPreviewHost {
  openExternal(
    url: string,
    options?: { readonly reportFailure?: boolean },
  ): Promise<void>;
  /** Open a workspace file in the OS default application. */
  openPath(filePath: string): Promise<void>;
  /**
   * The build-and-show preview of one open paper: a LaTeX source compiles
   * against `roots` (its workspace, its LaTeX settings) and its PDF opens in
   * that paper's workbench.
   */
  openBuildDisplayIn(roots: WorkspaceRoots): BuildDisplayFn;
}

interface DesktopPreviewHostOptions extends DesktopOverlayPostOptions {
  shell: DesktopShellAdapter;
  showErrorMessage?: (message: string) => Promise<void> | void;
  /** The process runtime a LaTeX preview compiles on. */
  runtime: ProcessRuntime;
}

/**
 * A preview step that could not run: the message the desktop already showed
 * in its dialog and the rejection its caller sees. The message is the whole
 * sentence the user reads, never a prefix over another one.
 */
class PreviewUnavailable extends Data.TaggedError('PreviewUnavailable')<{
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
    return Effect.tryPromise({
      try: async () => {
        await options.showErrorMessage?.(message);
      },
      catch: (error) =>
        new PreviewUnavailable({ message: toErrorMessage(error) }),
    }).pipe(
      Effect.flatMap(() => Effect.fail(new PreviewUnavailable({ message }))),
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
  ): Effect.Effect<void, unknown, ProcessServices> {
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
      if (!(yield* Effect.promise(() => hasLatexCompiler()))) {
        yield* fail(
          `No LaTeX compiler found for ${sourcePath}. Install latexmk or pdflatex to compile and preview this file.`,
        );
      }

      const { compileLatex2Pdf } = yield* Effect.promise(
        () => import('@latex/texTools'),
      );
      const built = yield* withSessionFs(
        roots,
        compileLatex2Pdf(createExternalLocation(sourcePath), roots.config, {
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

  // The host boundary: Electron's callers hold Promise-shaped methods, so the
  // programs above run on the runtime this host was handed.
  return {
    openBuildDisplayIn: (roots) => async (location) => {
      await options.runtime.runPromise(buildDisplayProgram(roots, location));
    },
    openExternal: async (url, { reportFailure = true } = {}) => {
      await options.runtime.runPromise(openExternalProgram(url, reportFailure));
    },
    openPath: async (filePath) => {
      await options.runtime.runPromise(openPathProgram(filePath));
    },
  };
}
