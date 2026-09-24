import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, FileSystem, type Path, type PlatformError } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { compileLatex2Pdf } from '@latex/texTools';
import { withLogChannel } from '@logger/effectLog';
import { withSessionFs } from '@platform/rootedFs';
import type { FileLocation } from '@shared/schemas';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@shared/constants/latexTiming';

// Local imports - utilities
import { getFileStem } from '@utils/core';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'OpenBuildUtils';

/**
 * A VS Code editor call as an Effect. The editor's promises reject with an
 * arbitrary value and can throw synchronously, neither of which is a typed
 * failure, so this is the module's single adapter onto that API — the
 * programs below recover through ordinary combinators.
 */
const vscodeCommand = <A>(call: () => Thenable<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: () => Promise.resolve(call()), catch: ensureError });

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
  vscodeCommand(() =>
    vscode.commands.executeCommand('latex-workshop.build', uri),
  ).pipe(
    Effect.catch((err) =>
      Effect.logWarning(`${warnLabel}: ${toErrorMessage(err)}`).pipe(
        withLogChannel(channel),
      ),
    ),
  );

/**
 * Open a file, compile if it is TeX, and display the resulting PDF.
 * The PDF viewer is refreshed if already loaded.
 *
 * Answers `true` when a surface was actually presented, and `false` when
 * the path is missing, the internal LaTeX compilation failed, or the PDF
 * viewer command rejected, so presentation callers can report non-delivery
 * truthfully.
 *
 * Workspace TeX files are built through LaTeX Workshop rather than the
 * internal compiler. A `latex-workshop.build` failure is warn-logged but does
 * not by itself make this resolve `false`: LaTeX Workshop surfaces its own
 * build-failure UI in the editor, so the returned boolean reports the
 * viewer-open outcome that follows the build attempt.
 */
export const openBuildDisplayIfTex = (
  session: SessionHandle,
  fileLocation: FileLocation,
  options: { preserveFocus?: boolean } = {},
): Effect.Effect<boolean, DisplayFailure, PreparedFileServices> =>
  Effect.gen(function* () {
    const prepared = yield* prepareFileForDisplay(
      session,
      fileLocation,
      options.preserveFocus ?? false,
    );
    if (prepared.kind !== 'latex-ready') return prepared.delivered;
    return yield* scheduleViewerDisplay;
  });

/**
 * Prepare a file for display (open, show, and build when TeX), optionally
 * scheduling the delayed PDF viewer.
 *
 * With `scheduleViewer` left `true` (the default) this settles after the
 * file-open/build phase completes and schedules the viewer without awaiting
 * its 5s confirmation. Set `scheduleViewer: false` to prepare several files
 * sequentially without scheduling viewer handoffs, then run
 * `scheduleViewerDisplay` once after the final file so LaTeX Workshop's
 * current document/root is the intended viewer target (#10553).
 */
export const prepareBuildDisplay = (
  session: SessionHandle,
  fileLocation: FileLocation,
  options: { preserveFocus?: boolean; scheduleViewer?: boolean } = {},
): Effect.Effect<boolean, DisplayFailure, PreparedFileServices> =>
  Effect.gen(function* () {
    const prepared = yield* prepareFileForDisplay(
      session,
      fileLocation,
      options.preserveFocus ?? false,
    );
    if (prepared.kind !== 'latex-ready') return prepared.delivered;

    if (options.scheduleViewer !== false) {
      // `scheduleViewerDisplay` never fails, so this is a deliberate detached
      // fiber rather than work this caller waits for. It starts immediately,
      // so its delay runs from here rather than from whenever a fiber next
      // gets the scheduler.
      yield* Effect.forkDetach(scheduleViewerDisplay, {
        startImmediately: true,
      });
    }
    return true;
  });

/** What the file-open/build phase takes from the runtime it is run on. */
type PreparedFileServices = FileSystem.FileSystem | Path.Path;

/** How it fails: the editor's own rejections, and the existence probe's. */
type DisplayFailure = Error | PlatformError.PlatformError;

type PrepareFileForDisplayResult =
  { kind: 'done'; delivered: boolean } | { kind: 'latex-ready' };

const prepareFileForDisplay = (
  session: SessionHandle,
  fileLocation: FileLocation,
  preserveFocus: boolean,
): Effect.Effect<
  PrepareFileForDisplayResult,
  DisplayFailure,
  PreparedFileServices
> =>
  Effect.gen(function* () {
    const absolutePath = fileLocation.absolutePath;

    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(absolutePath))) {
      yield* Effect.forkDetach(
        showLoggedMessage(CHANNEL, `File not found: ${absolutePath}`),
      );
      return { kind: 'done', delivered: false };
    }

    const uri = vscode.Uri.file(absolutePath);

    if (!isLatexFile(absolutePath)) {
      yield* vscodeCommand(() =>
        vscode.commands.executeCommand('vscode.open', uri, {
          preserveFocus,
        } satisfies vscode.TextDocumentShowOptions),
      );
      return { kind: 'done', delivered: true };
    }

    const prepared = yield* prepareLatexBuild(
      session,
      uri,
      fileLocation,
      preserveFocus,
    );
    return prepared
      ? { kind: 'latex-ready' }
      : { kind: 'done', delivered: false };
  });

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
const prepareLatexBuild = (
  session: SessionHandle,
  uri: vscode.Uri,
  fileLocation: FileLocation,
  preserveFocus: boolean,
): Effect.Effect<boolean, Error, PreparedFileServices> =>
  Effect.gen(function* () {
    const doc = yield* vscodeCommand(() =>
      vscode.workspace.openTextDocument(uri),
    );
    yield* vscodeCommand(() =>
      vscode.window.showTextDocument(doc, { preview: true, preserveFocus }),
    );

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
    const { roots } = session;
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
 * has rendered the PDF it was asked for. Detached when scheduled: it fires
 * long after the caller that scheduled it has moved on.
 */
const scheduleViewerRefresh: Effect.Effect<void> = Effect.gen(function* () {
  yield* Effect.sleep(LATEX_VIEWER_REFRESH_DELAY_MS);
  yield* vscodeCommand(() =>
    vscode.commands.executeCommand('latex-workshop.refresh-viewer'),
  ).pipe(
    Effect.catch((err) =>
      Effect.logWarning(`Viewer refresh failed: ${toErrorMessage(err)}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
});

/**
 * Schedule the PDF viewer open for the current LaTeX Workshop document/root.
 *
 * `latex-workshop.view` is argument-free and acts on LaTeX Workshop's current
 * context, so callers that prepare a batch of files should schedule this only
 * once, after the intended final file has been shown and built.
 *
 * Settles to `true` when `latex-workshop.view` accepts the open request, and
 * `false` when it rejects, so the caller can report viewer non-delivery.
 */
export const scheduleViewerDisplay: Effect.Effect<boolean> = Effect.gen(
  function* () {
    yield* Effect.sleep(LATEX_VIEWER_OPEN_DELAY_MS);
    return yield* vscodeCommand(() =>
      vscode.commands.executeCommand('latex-workshop.view'),
    ).pipe(
      // The refresh is scheduled only once the open has settled: a viewer that
      // never opened has nothing to refresh (#10556). It starts immediately so
      // its delay runs from the settlement, as the detached timer it replaces
      // did, rather than from whenever a fiber next gets the scheduler.
      Effect.tap(() =>
        Effect.forkDetach(scheduleViewerRefresh, { startImmediately: true }),
      ),
      Effect.as(true),
      Effect.catch((err) =>
        Effect.logWarning(`Viewer display failed: ${toErrorMessage(err)}`).pipe(
          withLogChannel(CHANNEL),
          Effect.as(false),
        ),
      ),
    );
  },
);
