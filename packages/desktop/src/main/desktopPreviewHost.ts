import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Effect, FileSystem, type Path, type PlatformError } from 'effect';

import {
  type ProcessRuntime,
  withProcessServices,
} from '@texra-ai/harness/host';
import { meansAbsent } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { isLatexFile } from '@texra/shared/latexFileTypes';
import { HostFailed } from '@texra/hosts/uiHosts';
import type {
  BuildDisplayFn,
  DisplayCompileFailed,
} from '@texra/controllers/approval/latexPreview';

import { DESKTOP_PDF_COMMANDS } from '../shared/desktopPdfMessages.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import type { FileLocation } from '@texra-ai/harness/schemas';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

interface DesktopShellAdapter {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
}

/**
 * The desktop's shell-facing open surface. `openExternal` and `openPath` are
 * the programs themselves: an Effect-native caller yields a member, and the
 * host entries that answer a framework callback run it once.
 *
 * `openBuildDisplayIn` answers with the core {@link BuildDisplayFn}, a
 * program like the rest: the approval controller forks it onto a fiber of its
 * own so a build outlives the preview program whose race for the first answer interrupts it.
 */
interface DesktopPreviewHost {
  /** Open a URL in the default browser. The shell's rejection is
   *  {@link HostFailed}; the caller presents it. */
  openExternal(url: string): Effect.Effect<void, HostFailed>;
  /** Open a workspace file in the OS default application; a file that is
   *  not there, or the shell's refusal, is {@link HostFailed}. */
  openPath(filePath: string): Effect.Effect<void, HostFailed>;
  /**
   * The build-and-show preview of one open project: a LaTeX source compiles
   * against `roots` (its workspace, its LaTeX settings) and its PDF opens in
   * that project's workbench.
   */
  openBuildDisplayIn(roots: WorkspaceRoots): BuildDisplayFn;
}

interface DesktopPreviewHostOptions {
  postToRenderer(message: DesktopPush): void;
  shell: DesktopShellAdapter;
  /** The process runtime the window was handed. It only supplies the
   *  filesystem `openPath` probes through; nothing else runs on it. */
  runtime: ProcessRuntime;
}

export function createDesktopPreviewHost(
  options: DesktopPreviewHostOptions,
): DesktopPreviewHost {
  /** The builds this host has shown: each tab reload names the newest. */
  let builds = 0;
  /** `member`'s failure in a sentence of its own. The sentence already
   *  says what went wrong, and the cause would add the system error's
   *  words to it, so none is kept. */
  const fail = (
    member: string,
    message: string,
  ): Effect.Effect<never, HostFailed> =>
    Effect.fail(new HostFailed({ member, message, cause: undefined }));

  function ensurePathExists(
    member: string,
    filePath: string,
  ): Effect.Effect<void, HostFailed, FileSystem.FileSystem> {
    return FileSystem.FileSystem.use((fs) => fs.access(filePath)).pipe(
      Effect.catch((error: PlatformError.PlatformError) =>
        fail(
          member,
          meansAbsent(error)
            ? `File not found: ${filePath}`
            : `Cannot access file ${filePath}: ${toErrorMessage(error)}`,
        ),
      ),
    );
  }

  const openPathProgram = Effect.fn('openPathProgram')(function* (
    filePath: string,
  ): Effect.fn.Return<void, HostFailed, FileSystem.FileSystem> {
    yield* ensurePathExists('openPath', filePath);

    const shellError = yield* Effect.tryPromise({
      try: () => options.shell.openPath(filePath),
      catch: toErrorMessage,
    }).pipe(Effect.catch((message) => Effect.succeed(message)));

    if (shellError) {
      return yield* fail(
        'openPath',
        `Failed to open file ${filePath}: ${shellError}`,
      );
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
    HostFailed | DisplayCompileFailed,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const sourcePath = fileLocation.absolutePath;
    yield* ensurePathExists('openBuildDisplay', sourcePath);

    if (!isLatexFile(sourcePath)) {
      yield* openPathProgram(sourcePath);
      return;
    }

    // Loaded on the first preview, not with the window.
    const { compileForDisplay } = yield* Effect.promise(
      () => import('@texra/controllers/approval/latexPreview'),
    );
    // The PDF lands beside its source; a failure's sentence is presented in
    // a native dialog (desktopWindowHost.ts's `presented`).
    const pdfPath = yield* compileForDisplay(
      roots,
      fileLocation,
      path.dirname(sourcePath),
    );

    // A successful build names a PDF on disk. Every build gets its own
    // number, so its tab reloads however close in time two builds land.
    // It opens in the renderer's pdf workbench tab (an `<iframe>` on
    // Electron's built-in Chromium viewer).
    options.postToRenderer({
      command: DESKTOP_PDF_COMMANDS.SHOW_PDF,
      session: roots.storage,
      title: path.basename(pdfPath),
      pdfUrl: pathToFileURL(pdfPath).href,
      build: ++builds,
    });
  });

  return {
    openBuildDisplayIn: (roots) => (location) =>
      buildDisplayProgram(roots, location),
    openExternal,
    openPath: (filePath) =>
      withProcessServices(options.runtime, openPathProgram(filePath)),
  };
}
