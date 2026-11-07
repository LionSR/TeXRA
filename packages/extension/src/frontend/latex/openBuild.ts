import * as os from 'node:os';
import * as path from 'node:path';
import {
  getFileStem,
  type FileLocation,
  toErrorMessage,
} from '@texra-ai/harness/schemas';

import * as vscode from 'vscode';
import {
  Effect,
  Exit,
  FileSystem,
  type Path,
  type PlatformError,
  type Scope,
} from 'effect';

import {
  withLogChannel,
  withSessionFs,
  pathToLocationIn,
} from '@texra-ai/harness/host';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { compileLatex2Pdf } from '@latex/texTools';
import { isLatexFile } from '@texra/shared/latexFileTypes';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@texra/shared/constants/latexTiming';

// Local imports - utilities
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'OpenBuildUtils';

/**
 * Resolve `latex-workshop.latex.outDir` by expanding all LaTeX Workshop
 * placeholders for the given file.  Longer placeholders are replaced first
 * so that e.g. `%DOC_EXT%` is not partially consumed by `%DOC%`.
 *
 * Falls back to a relative path resolved against the file's directory when the
 * result is not absolute.
 */
function resolveLatexWorkshopOutDir(filePath: string): string {
  const raw = vscode.workspace
    .getConfiguration('latex-workshop.latex')
    .get<string>('outDir', '%DIR%/build');

  const dir = path.dirname(filePath);
  const normalizedRaw = raw.trim();
  if (!normalizedRaw) {
    return path.join(dir, 'build');
  }

  const docfile = getFileStem(filePath);
  const doc = path.join(dir, docfile);
  // The first folder, not the file's own: LaTeX Workshop's
  // `replaceArgumentPlaceholders` expands these against
  // `workspaceFolders[0]`, and the viewer looks for the PDF where it would.
  // The callers' files sit outside every folder anyway.
  const workspaceFolder =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dir;
  const relativeDir = path.relative(workspaceFolder, dir);
  const relativeDoc = path.relative(workspaceFolder, doc);

  // Order matters: longer/more-specific placeholders first to avoid partial matches.
  const replacements: [string, string][] = [
    ['%DOC_EXT_W32%', filePath.replaceAll('/', '\\')],
    ['%DOCFILE_EXT%', path.basename(filePath)],
    ['%DOC_EXT%', filePath],
    ['%DOCFILE%', docfile],
    ['%DOC_W32%', doc.replaceAll('/', '\\')],
    ['%DOC%', doc],
    ['%DIR_W32%', dir.replaceAll('/', '\\')],
    ['%DIR%', dir],
    ['%WORKSPACE_FOLDER%', workspaceFolder],
    ['%RELATIVE_DIR%', relativeDir],
    ['%RELATIVE_DOC%', relativeDoc],
    ['%TMPDIR%', os.tmpdir()],
  ];

  const resolved = replacements.reduce(
    (acc, [placeholder, value]) => acc.replaceAll(placeholder, value),
    normalizedRaw,
  );

  return path.isAbsolute(resolved) ? resolved : path.resolve(dir, resolved);
}

/**
 * Invoke the LaTeX Workshop build command for a file, warn-logging on failure.
 * `warnLabel` prefixes the failure message so callers keep their diagnostic context.
 */
export const invokeLatexWorkshopBuild = (
  uri: vscode.Uri,
  channel: string,
  warnLabel: string,
): Effect.Effect<void> =>
  executeVscodeCommand('latex-workshop.build', uri).pipe(
    Effect.catch((err) =>
      Effect.logWarning(`${warnLabel}: ${toErrorMessage(err)}`).pipe(
        withLogChannel(channel),
      ),
    ),
  );

/**
 * Show each file in order, building the TeX ones, then open the PDF viewer
 * once, for the last file whose build left a PDF to show.
 *
 * `latex-workshop.view` takes no argument and shows LaTeX Workshop's current
 * document, so when a later file took that place (it had no PDF to show, or
 * showing it failed) the viewer's file is opened in the editor again first.
 * The viewer opens in the caller's scope after this returns, on the failing
 * path too, and a failure to open it is logged at warn.
 *
 * Workspace TeX files are built through LaTeX Workshop rather than the
 * internal compiler. A `latex-workshop.build` failure is only warn-logged:
 * LaTeX Workshop shows its own build-failure UI in the editor.
 */
export const openBuilt = Effect.fn('openBuild.openBuilt')(function* (
  roots: WorkspaceRoots,
  locations: readonly [FileLocation, ...FileLocation[]],
  options: { preserveFocus?: boolean } = {},
): Effect.fn.Return<void, DisplayFailure, PreparedFileServices | Scope.Scope> {
  const preserveFocus = options.preserveFocus ?? false;
  let viewerFile: FileLocation | undefined;
  yield* Effect.gen(function* () {
    for (const location of locations) {
      if (yield* prepareFileForDisplay(roots, location, preserveFocus))
        viewerFile = location;
    }
  }).pipe(
    Effect.onExit((exit) => {
      if (viewerFile === undefined) return Effect.void;
      const stillCurrent =
        Exit.isSuccess(exit) &&
        viewerFile.absolutePath === locations.at(-1)?.absolutePath;
      return (
        stillCurrent
          ? Effect.succeed(true)
          : reopenViewerFile(viewerFile, preserveFocus)
      ).pipe(
        Effect.flatMap((ready) =>
          ready
            ? // In the caller's scope: the viewer opens after this returns,
              // and closing that scope cancels an open still waiting.
              Effect.forkScoped(openViewer, { startImmediately: true })
            : Effect.void,
        ),
      );
    }),
  );
});

/**
 * Make the viewer's file LaTeX Workshop's current document again, answering
 * whether it is. A failed open is a reason to skip the viewer rather than
 * show an unrelated PDF; it is logged at warn.
 */
const reopenViewerFile = (
  location: FileLocation,
  preserveFocus: boolean,
): Effect.Effect<boolean> =>
  openFileInEditor(location.absolutePath, {
    preview: true,
    preserveFocus,
  }).pipe(
    Effect.as(true),
    Effect.catch((err) =>
      Effect.logWarning(
        `Could not reopen ${location.absolutePath} before opening the PDF viewer: ${toErrorMessage(err)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(false)),
    ),
  );

/** What the file-open/build phase takes from the runtime it is run on. */
type PreparedFileServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner;

/** How it fails: the editor's own rejections, and the existence probe's. */
type DisplayFailure = Error | PlatformError.PlatformError;

/** Show one file, building it when it is TeX, answering whether its build
 *  left a PDF for the viewer. */
const prepareFileForDisplay = Effect.fn('openBuild.prepareFileForDisplay')(
  function* (
    roots: WorkspaceRoots,
    fileLocation: FileLocation,
    preserveFocus: boolean,
  ): Effect.fn.Return<boolean, DisplayFailure, PreparedFileServices> {
    const absolutePath = fileLocation.absolutePath;

    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(absolutePath))) {
      yield* showLoggedMessage(CHANNEL, `File not found: ${absolutePath}`);
      return false;
    }

    const uri = vscode.Uri.file(absolutePath);

    if (!isLatexFile(absolutePath)) {
      yield* executeVscodeCommand('vscode.open', uri, {
        preserveFocus,
      } satisfies vscode.TextDocumentShowOptions);
      return false;
    }

    return yield* prepareLatexBuild(roots, uri, fileLocation, preserveFocus);
  },
);

/**
 * Open a LaTeX file and run its build path, answering whether the PDF viewer
 * should still be opened (`false` only when internal compilation failed).
 *
 * Files inside the workspace are compiled via LaTeX Workshop so the user
 * gets the full editor integration (synctex, diagnostics, etc.).
 *
 * Files outside the workspace (e.g. in run-storage) are compiled with the
 * internal `compileLatex2Pdf` helper which sets TEXINPUTS to include the
 * workspace root, ensuring project-local .sty / .cls / .bib files are found.
 */
const prepareLatexBuild = Effect.fn('openBuild.prepareLatexBuild')(function* (
  roots: WorkspaceRoots,
  uri: vscode.Uri,
  fileLocation: FileLocation,
  preserveFocus: boolean,
): Effect.fn.Return<boolean, Error, PreparedFileServices> {
  yield* openFileInEditor(uri.fsPath, { preview: true, preserveFocus });

  if (fileLocation.kind === 'workspace') {
    yield* invokeLatexWorkshopBuild(
      uri,
      CHANNEL,
      'LaTeX Workshop build failed',
    );
    return true;
  }

  // Outside workspace — LaTeX Workshop cannot resolve project-local
  // packages, so compile internally with TEXINPUTS set.
  // Resolve the same outDir that LaTeX Workshop uses so the viewer finds the PDF.
  const outDir = resolveLatexWorkshopOutDir(uri.fsPath);
  const compiled = yield* withSessionFs(
    roots,
    compileLatex2Pdf(pathToLocationIn(roots.workspace, uri.fsPath), roots, {
      outputDirectory: outDir,
    }),
  );
  if (!compiled.ok) {
    // Include the tail in the visible message itself, not just structured
    // data, because this failure must be visible at the default log level.
    yield* Effect.logWarning(
      `Internal LaTeX compilation failed for ${uri.fsPath}:\n${compiled.logTail}`,
    ).pipe(
      Effect.annotateLogs({
        data: { sourceFile: uri.fsPath, logTail: compiled.logTail },
      }),
      withLogChannel(CHANNEL),
    );
    return false;
  }

  return true;
});

/**
 * The refresh that follows a successful viewer open, delayed so LaTeX Workshop
 * has rendered the PDF it was asked for. Forked into the caller's scope when
 * scheduled: it fires long after the caller that scheduled it has moved on.
 */
const scheduleViewerRefresh: Effect.Effect<void> = Effect.gen(function* () {
  yield* Effect.sleep(LATEX_VIEWER_REFRESH_DELAY_MS);
  yield* executeVscodeCommand('latex-workshop.refresh-viewer').pipe(
    Effect.catch((err) =>
      Effect.logWarning(`Viewer refresh failed: ${toErrorMessage(err)}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
});

/**
 * Open the PDF viewer on LaTeX Workshop's current document, then refresh it.
 * A rejected open is logged at warn, and leaves nothing to refresh.
 */
const openViewer: Effect.Effect<void, never, Scope.Scope> = Effect.gen(
  function* () {
    yield* Effect.sleep(LATEX_VIEWER_OPEN_DELAY_MS);
    yield* executeVscodeCommand('latex-workshop.view').pipe(
      // It starts immediately so its delay runs from the open rather than
      // from whenever a fiber next gets the scheduler.
      Effect.andThen(
        Effect.forkScoped(scheduleViewerRefresh, { startImmediately: true }),
      ),
      Effect.catch((err) =>
        Effect.logWarning(`Viewer display failed: ${toErrorMessage(err)}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );
  },
);
