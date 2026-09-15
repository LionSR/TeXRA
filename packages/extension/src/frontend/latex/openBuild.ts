import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import * as vscode from 'vscode';
import { Effect, FileSystem } from 'effect';

import { defaultSession } from '@agent/runtime';
import { isNotADirectoryError } from '@common/errors';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { compileLatex2Pdf } from '@latex/texTools';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs } from '@platform/rootedFs';
import type { FileLocation } from '@shared/schemas';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@shared/constants/latexTiming';

// Local imports - utilities
import { getFileStem } from '@utils/core';
import { pathToLocation } from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'OpenBuildUtils';
const log = createLog(CHANNEL);

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

  let resolved = normalizedRaw;
  for (const [placeholder, value] of replacements) {
    resolved = resolved.replaceAll(placeholder, value);
  }

  return path.isAbsolute(resolved) ? resolved : path.resolve(dir, resolved);
}

/**
 * Invoke the LaTeX Workshop build command for a file, warn-logging on failure.
 * `warnLabel` prefixes the failure message so callers keep their diagnostic context.
 */
export async function invokeLatexWorkshopBuild(
  uri: vscode.Uri,
  channel: string,
  warnLabel: string,
): Promise<void> {
  const log = createLog(channel);
  // `executeCommand` rejects in VS Code's own Promise world; `tryPromise` puts
  // that rejection in the typed channel so the recovery below warn-logs it.
  // The run sits at this outermost Promise-facing function, and this file
  // imports `effect`, so its catch sites convert with it (R7).
  await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand('latex-workshop.build', uri);
      },
      catch: toErrorMessage,
    }).pipe(
      Effect.catch((message) =>
        Effect.sync(() => log.warn(`${warnLabel}: ${message}`)),
      ),
    ),
  );
}

/**
 * Open a file, compile if it is TeX, and display the resulting PDF.
 * The PDF viewer is refreshed if already loaded.
 *
 * Resolves `true` when a surface was actually presented, and `false` when
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
export async function openBuildDisplayIfTex(
  fileLocation: FileLocation,
  runtime: ProcessRuntime,
  options: { preserveFocus?: boolean } = {},
): Promise<boolean> {
  const prepared = await prepareFileForDisplay(
    fileLocation,
    options.preserveFocus ?? false,
    runtime,
  );
  if (prepared.kind !== 'latex-ready') return prepared.delivered;
  return scheduleViewerDisplay();
}

/**
 * Prepare a file for display (open, show, and build when TeX), optionally
 * scheduling the delayed PDF viewer.
 *
 * With `scheduleViewer` left `true` (the default) this resolves after the
 * file-open/build phase completes and schedules the viewer without awaiting
 * its 5s confirmation. Set `scheduleViewer: false` to prepare several files
 * sequentially without scheduling viewer handoffs, then call
 * `scheduleViewerDisplay` once after the final file so LaTeX Workshop's
 * current document/root is the intended viewer target (#10553).
 */
export async function prepareBuildDisplay(
  fileLocation: FileLocation,
  runtime: ProcessRuntime,
  options: { preserveFocus?: boolean; scheduleViewer?: boolean } = {},
): Promise<boolean> {
  const prepared = await prepareFileForDisplay(
    fileLocation,
    options.preserveFocus ?? false,
    runtime,
  );
  if (prepared.kind !== 'latex-ready') return prepared.delivered;

  if (options.scheduleViewer !== false) {
    // `scheduleViewerDisplay` always settles to a boolean, so this is a
    // deliberate detached side effect rather than an unhandled promise.
    void scheduleViewerDisplay();
  }
  return true;
}

type PrepareFileForDisplayResult =
  { kind: 'done'; delivered: boolean } | { kind: 'latex-ready' };

async function prepareFileForDisplay(
  fileLocation: FileLocation,
  preserveFocus: boolean,
  runtime: ProcessRuntime,
): Promise<PrepareFileForDisplayResult> {
  const absolutePath = fileLocation.absolutePath;

  // A path the user picked is absolute, so it is the process filesystem's, not
  // a rooted view's. A path whose parent is not a directory is a missing file,
  // not a failure: `AbsoluteFS.exists` counted ENOTDIR as absent alongside
  // ENOENT, and `FileSystem.exists` reports it as `BadResource`. The predicate
  // names ENOTDIR specifically so an operational failure still propagates.
  const exists = await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.exists(absolutePath).pipe(
        Effect.catchIf(
          (error) =>
            error.reason._tag === 'BadResource' &&
            isNotADirectoryError(error.reason.cause),
          () => Effect.succeed(false),
        ),
      );
    }),
  );
  if (!exists) {
    void showLoggedMessage(CHANNEL, `File not found: ${absolutePath}`);
    return { kind: 'done', delivered: false };
  }

  const uri = vscode.Uri.file(absolutePath);

  if (!isLatexFile(absolutePath)) {
    await vscode.commands.executeCommand('vscode.open', uri, {
      preserveFocus,
    } satisfies vscode.TextDocumentShowOptions);
    return { kind: 'done', delivered: true };
  }

  const prepared = await prepareLatexBuild(
    uri,
    fileLocation,
    preserveFocus,
    runtime,
  );
  return prepared
    ? { kind: 'latex-ready' }
    : { kind: 'done', delivered: false };
}

/**
 * Open a LaTeX file and run its build path, returning whether the PDF viewer
 * should still be opened (`false` only when internal compilation failed).
 *
 * Files inside the workspace are compiled via LaTeX Workshop so the user
 * gets the full editor integration (synctex, diagnostics, etc.).
 *
 * Files outside the workspace (e.g. in run-storage) are compiled with the
 * internal `compileLatex2Pdf` helper which sets TEXINPUTS to include the
 * workspace root, ensuring project-local .sty / .cls / .bib files are found.
 */
async function prepareLatexBuild(
  uri: vscode.Uri,
  fileLocation: FileLocation,
  preserveFocus: boolean,
  runtime: ProcessRuntime,
): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus });

  if (fileLocation.kind === 'workspace') {
    await invokeLatexWorkshopBuild(uri, CHANNEL, 'LaTeX Workshop build failed');
    return true;
  }

  // Outside workspace — LaTeX Workshop cannot resolve project-local
  // packages, so compile internally with TEXINPUTS set.
  // Resolve the same outDir that LaTeX Workshop uses so the viewer finds the PDF.
  const outDir = resolveLatexWorkshopOutDir(uri.fsPath);
  const { roots } = defaultSession();
  const compiled = await runtime.runPromise(
    withSessionFs(
      roots,
      compileLatex2Pdf(pathToLocation(uri.fsPath), roots.config, {
        outputDirectory: outDir,
      }),
    ),
  );
  if (!compiled.ok) {
    // Include the tail in the visible message itself, not just `data` —
    // writeLine only shows `data` when texra.logger.debugMode is on
    // (default off), and this failure's whole point is to be visible
    // without needing to enable debug logging.
    log.warn(
      `Internal LaTeX compilation failed for ${uri.fsPath}:\n${compiled.logTail}`,
      { data: { sourceFile: uri.fsPath, logTail: compiled.logTail } },
    );
    return false;
  }

  return true;
}

/**
 * Schedule the PDF viewer open for the current LaTeX Workshop document/root.
 *
 * `latex-workshop.view` is argument-free and acts on LaTeX Workshop's current
 * context, so callers that prepare a batch of files should schedule this only
 * once, after the intended final file has been shown and built.
 *
 * Resolves `true` when `latex-workshop.view` accepts the open request, and
 * `false` when it rejects, so the caller can report viewer non-delivery.
 */
export async function scheduleViewerDisplay(): Promise<boolean> {
  await sleep(LATEX_VIEWER_OPEN_DELAY_MS);
  // As in `invokeLatexWorkshopBuild`: the two VS Code commands reject in their
  // own runtime, so each `tryPromise` carries that rejection into the typed
  // channel and the recovery warn-logs it. The refresh stays a detached side
  // effect scheduled only after the view opened, exactly as the nested
  // `try`/`catch` did.
  const displayed = await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand('latex-workshop.view');
      },
      catch: toErrorMessage,
    }).pipe(
      Effect.as(true),
      Effect.catch((message) =>
        Effect.sync(() => {
          log.warn(`Viewer display failed: ${message}`);
          return false;
        }),
      ),
    ),
  );
  if (!displayed) return false;

  void sleep(LATEX_VIEWER_REFRESH_DELAY_MS).then(() =>
    Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          await vscode.commands.executeCommand('latex-workshop.refresh-viewer');
        },
        catch: toErrorMessage,
      }).pipe(
        Effect.catch((message) =>
          Effect.sync(() => log.warn(`Viewer refresh failed: ${message}`)),
        ),
      ),
    ),
  );
  return true;
}
