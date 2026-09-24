// Main-process IPC for the workspace shell surfaces: editor file I/O, terminal
// pty sessions, and embedded browser tabs.
//
// All three are renderer-driven, and the renderer is sandboxed with no node
// integration, so every request lands here. Requests are Zod-validated at the
// boundary and — for file I/O — confined to the workspace root before touching
// disk: a path from the renderer is untrusted input, and `../` traversal would
// otherwise read or overwrite anything the user can reach.
//
// Every disk operation below is a program over the standard library's
// `FileSystem`, settled on the runtime the window handed this handler. The
// paths they receive are the canonical ones the containment check above
// already vouched for, which a workspace symlink can legitimately place
// outside the lexical project root — so they go to the process filesystem, not
// to a root-confined view that would refuse exactly those.

import { basename, dirname, join } from 'node:path';

import { Data, Effect, FileSystem, type PlatformError } from 'effect';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@common/files/fileListingRules';
import { FILE_HANDLING_RULES } from '@common/files/fileHandlingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { onAppSignal } from '@eventBus/AppSignals';
import type { ProcessRuntime } from '@platform/processRuntime';
import { normalizeFilePath } from '@utils/core';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  entryTypeAt,
  readDirectoryTypedTolerant,
} from '@utils/files/fsDurability';
import { OFFICE_EXTENSIONS } from '@utils/files/mimeUtils';
import { normalizeLineEndings } from '@utils/text/stringUtils';

import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
  type DesktopBrowserBounds,
} from '../shared/desktopWorkspaceMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';
import type { DesktopPtyHost } from './desktopPtyHost.js';
import type { DesktopBrowserViews } from './desktopBrowserViews.js';

interface DesktopWorkspaceIpcOptions {
  ptyHost: DesktopPtyHost;
  browserViews: DesktopBrowserViews;
  /**
   * Translates renderer-reported CSS pixel bounds into window coordinates.
   * A WebContentsView is positioned in device-independent window space, which
   * differs from the renderer's own coordinates under display zoom.
   */
  toWindowBounds(bounds: DesktopBrowserBounds): DesktopBrowserBounds;
  /**
   * Root of the project this window shows, and the only workspace root this
   * handler resolves against — a request names a path relative to the project
   * it was sent for, not to whichever project happens to be active. An
   * app-signal listener hears every project's writes, including a run in
   * another open project; the window's own project is what a re-list decision
   * compares to.
   */
  getWorkspacePath(): string | undefined;
  onAsyncError(error: unknown): void;
  /** The process runtime the window was handed; every program below settles
   *  on it. */
  runtime: ProcessRuntime;
}

interface DesktopWorkspaceIpc extends DesktopMessageHandler {
  /**
   * Releases resources owned by the current renderer document.
   *
   * Renderer reload creates a new terminal-id namespace and a new browser-tab
   * layout, so neither resource may survive across that boundary.
   */
  disposeRendererResources(): void;

  /**
   * Tells the renderer to re-list its file tree when a write lands inside
   * this project, until interrupted. The window forks it into the project
   * binding's scope, which a renderer reload replaces along with this IPC.
   */
  readonly followFilesWritten: Effect.Effect<void>;
}

/**
 * A workspace request the editor refused, carrying the whole sentence the
 * renderer shows for it — never a prefix over another message.
 */
class WorkspaceRequestRefused extends Data.TaggedError(
  'WorkspaceRequestRefused',
)<{
  readonly message: string;
}> {}

/**
 * A host promise this handler awaited rejected. `member` names which, so the
 * report says what actually failed, and `message` is the rejection's own text
 * so the sentence the renderer shows is unchanged.
 */
class WorkspaceHostCallFailed extends Data.TaggedError(
  'WorkspaceHostCallFailed',
)<{
  readonly member: 'ptyHost.create';
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Everything a file-I/O program here can fail with. */
type WorkspaceFileFailure =
  WorkspaceRequestRefused | PlatformError.PlatformError;

/** The single workspace-boundary error every containment path reports. */
const WORKSPACE_BOUNDARY_ERROR =
  'Only files inside the workspace folder can be opened.';

/**
 * Absent, and nothing else. A path that is not there is the write path's
 * expected case; a permission or I/O failure on the same call is a real fault
 * and must not read as "the file does not exist yet".
 */
const isAbsent = (error: WorkspaceFileFailure): boolean =>
  error._tag === 'PlatformError' && error.reason._tag === 'NotFound';

/**
 * Enforces that a canonical target lies within the canonical workspace root,
 * answering the target on success. Both inputs must already be canonicalized
 * (the write path synthesizes its target from a canonical parent plus
 * basename), so a symlink or `..` traversal cannot escape the project.
 */
function assertWithinWorkspace(
  canonicalRoot: string,
  canonicalTarget: string,
): Effect.Effect<string, WorkspaceRequestRefused> {
  return isPathWithin(canonicalRoot, canonicalTarget)
    ? Effect.succeed(canonicalTarget)
    : Effect.fail(
        new WorkspaceRequestRefused({ message: WORKSPACE_BOUNDARY_ERROR }),
      );
}

/**
 * Lexical workspace containment check against `root`: rejects `..` traversal,
 * or fails. The root is the project this handler was built for, passed in
 * rather than read from the calling context's roots scope, so a request can
 * only ever be resolved against its own project.
 */
function locateWorkspaceTarget(
  root: string | undefined,
  inputPath: string,
): Effect.Effect<
  { absolutePath: string; root: string },
  WorkspaceRequestRefused
> {
  const located = locateInWorkspace(root, inputPath);
  if (located.kind !== 'workspace') {
    return Effect.fail(
      new WorkspaceRequestRefused({ message: WORKSPACE_BOUNDARY_ERROR }),
    );
  }
  if (!root) {
    return Effect.fail(
      new WorkspaceRequestRefused({
        message: 'Workspace path is not available.',
      }),
    );
  }
  return Effect.succeed({ absolutePath: located.absolutePath, root });
}

/**
 * Resolves a renderer-supplied path inside the workspace, or fails.
 *
 * The lexical check rejects `..` traversal first. Canonical paths are then
 * compared so a workspace symlink cannot lead the editor outside the project.
 */
const resolveWorkspacePath = Effect.fn(
  'desktopWorkspaceIpc.resolveWorkspacePath',
)(function* (workspaceRoot: string | undefined, inputPath: string) {
  const { absolutePath, root } = yield* locateWorkspaceTarget(
    workspaceRoot,
    inputPath,
  );
  const fs = yield* FileSystem.FileSystem;
  const [canonicalRoot, canonicalTarget] = yield* Effect.all(
    [fs.realPath(root), fs.realPath(absolutePath)],
    { concurrency: 2 },
  );
  return yield* assertWithinWorkspace(canonicalRoot, canonicalTarget);
});

/**
 * Resolves a write target without requiring the file itself to still exist.
 * The canonical parent remains mandatory, so recreating an externally deleted
 * file cannot bypass the workspace or symlink boundary.
 */
const resolveWorkspaceWritePath = Effect.fn(
  'desktopWorkspaceIpc.resolveWorkspaceWritePath',
)(function* (workspaceRoot: string | undefined, inputPath: string) {
  const existing = yield* resolveWorkspacePath(workspaceRoot, inputPath).pipe(
    Effect.catchIf(isAbsent, () => Effect.succeed(undefined)),
  );
  if (existing !== undefined) return existing;

  const { absolutePath, root } = yield* locateWorkspaceTarget(
    workspaceRoot,
    inputPath,
  );
  const fs = yield* FileSystem.FileSystem;
  const parent = dirname(absolutePath);
  const name = basename(absolutePath);

  // A dangling symlink also makes realPath fail with ENOENT. It must remain
  // rejected: writing through it could create a target outside the workspace.
  // One lstat on the target itself is what reports a link as itself — `stat`
  // follows it — on case-insensitive volumes too, and any failure other than
  // "not there" refuses the write instead of reading as "no link here".
  const entryType = yield* entryTypeAt(absolutePath).pipe(
    Effect.catchIf(isAbsent, () => Effect.succeed(undefined)),
  );
  if (entryType === 'SymbolicLink') {
    return yield* Effect.fail(
      new WorkspaceRequestRefused({
        message: 'Symbolic links cannot be recreated by the editor.',
      }),
    );
  }

  const [canonicalRoot, canonicalParent] = yield* Effect.all(
    [fs.realPath(root), fs.realPath(parent)],
    { concurrency: 2 },
  ).pipe(
    Effect.catchIf(isAbsent, () =>
      Effect.fail(
        new WorkspaceRequestRefused({
          message:
            'The file cannot be recreated because its parent folder no longer exists.',
        }),
      ),
    ),
  );
  return yield* assertWithinWorkspace(
    canonicalRoot,
    join(canonicalParent, name),
  );
});

export function createDesktopWorkspaceIpc(
  renderer: DesktopRenderer,
  options: DesktopWorkspaceIpcOptions,
): DesktopWorkspaceIpc {
  // Accepted run outputs and accepted LaTeX diffs write straight to disk, past
  // the editor's own write path, and the file tree caches its listing with no
  // watcher behind it — this signal is its only notice, and without it the
  // tree stays stale until the user hits Refresh. A write outside the
  // workspace root cannot appear in the tree, so it is not worth a re-list.
  const followFilesWritten = onAppSignal(
    'workspaceFilesWritten',
    ({ absolutePaths }) => {
      const root = options.getWorkspacePath();
      if (!root) return;
      if (!absolutePaths.some((path) => isPathWithin(root, path))) return;
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED,
      });
    },
  );

  /**
   * Report the failure and tell the renderer its request failed. Loud by
   * construction: the window's own async-error reporter sees the cause and the
   * request never settles in silence.
   */
  function reportRequestFailure(
    error: unknown,
    message: DesktopCommandMessage,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      options.onAsyncError(error);
      renderer.postToRenderer(message);
    });
  }

  function reportFileFailure(
    requestId: string,
    path: string,
  ): (error: WorkspaceFileFailure) => Effect.Effect<void> {
    return (error) =>
      reportRequestFailure(error, {
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR,
        requestId,
        path,
        message: toErrorMessage(error),
      });
  }

  const listDirectory = Effect.fn('desktopWorkspaceIpc.listDirectory')(
    function* (requestId: string, directory: string) {
      const root = options.getWorkspacePath();
      if (!root) {
        renderer.postToRenderer({
          command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
          requestId,
          directory,
          files: [],
        });
        return;
      }

      // The project tree is a code editor, not the agent input picker. Reuse
      // the shared ignore policy, but do not inherit
      // the input picker's `.ts`/`.js`/`.json` exclusions. Only known binary
      // media and office formats are hidden from this text editor.
      const filters = prepareFileFilters({
        include: [],
        excludeExtensions: [
          ...new Set([
            ...getIncludedExtensions('media'),
            ...OFFICE_EXTENSIONS,
            '.vsix',
          ]),
        ],
        excludeDirs: [...FILE_HANDLING_RULES.ignored.directories],
        excludeKeywords: [],
        excludeFiles: [],
      });
      const absoluteDirectory = directory
        ? yield* resolveWorkspacePath(root, directory)
        : root;
      // The typed listing reports a link as itself; `readDirectory` answers
      // names alone and `stat` would follow a link to what it points at. The
      // tolerant form drops an entry whose type cannot be read (warn-logged)
      // rather than failing the tree: readdir already named every entry, so
      // one unreadable row must not cost the directory.
      const entries = yield* readDirectoryTypedTolerant(absoluteDirectory);
      const files = entries
        .toSorted(([left], [right]) =>
          left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: 'base',
          }),
        )
        .flatMap(([name, type]) => {
          if (type === 'SymbolicLink') return [];
          const path = normalizeFilePath(
            directory ? join(directory, name) : name,
          );
          if (type === 'Directory') {
            return shouldVisitDirectory(path, filters)
              ? [{ path, isDirectory: true }]
              : [];
          }
          return type === 'File' && passesFileFilters(path, filters)
            ? [{ path, isDirectory: false }]
            : [];
        });
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
        requestId,
        directory,
        files,
      });
    },
  );

  function listFiles(requestId: string, directory: string) {
    const normalizedDirectory = normalizeFilePath(directory)
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    return listDirectory(requestId, normalizedDirectory).pipe(
      // A listing fails two ways and both are answered the same way: a path
      // refused past the workspace boundary, and a directory the process
      // filesystem could not read. The handler names that pair instead of
      // inferring it, so a third tag added to the listing's channel fails to
      // compile here rather than being reported as a listing error.
      Effect.catch((error: WorkspaceFileFailure) =>
        reportRequestFailure(error, {
          command: DESKTOP_WORKSPACE_COMMANDS.FILES_LIST_ERROR,
          requestId,
          directory: normalizedDirectory,
          message: toErrorMessage(error),
        }),
      ),
    );
  }

  function readFile(requestId: string, path: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const absolutePath = yield* resolveWorkspacePath(
        options.getWorkspacePath(),
        path,
      );
      // The editor's buffers are LF-only, as every read of a workspace file
      // through the shared facade this replaces already was. Decoding the
      // bytes ourselves keeps a UTF-8 BOM, which `readFileString`'s decoder
      // strips and the editor's verbatim save would otherwise delete.
      const contents = normalizeLineEndings(
        Buffer.from(yield* fs.readFile(absolutePath)).toString('utf8'),
      );
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        requestId,
        path,
        contents,
      });
    }).pipe(Effect.catch(reportFileFailure(requestId, path)));
  }

  function writeFile(requestId: string, path: string, contents: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const absolutePath = yield* resolveWorkspaceWritePath(
        options.getWorkspacePath(),
        path,
      );
      yield* fs.writeFileString(absolutePath, contents);
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
        requestId,
        path,
      });
    }).pipe(Effect.catch(reportFileFailure(requestId, path)));
  }

  function startTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    initialCommand?: string,
  ) {
    return Effect.gen(function* () {
      const session = yield* Effect.tryPromise({
        try: () => options.ptyHost.create({ id: sessionId, cols, rows }),
        catch: (cause) =>
          new WorkspaceHostCallFailed({
            member: 'ptyHost.create',
            message: toErrorMessage(cause),
            cause,
          }),
      });
      if (!session) return;
      if (initialCommand) {
        session.write(`${initialCommand}\r`);
      }
    }).pipe(
      // The handler's parameter is the whole error type this expression can
      // carry, so a second failure added here fails to compile rather than
      // being absorbed as a terminal that would not start.
      Effect.catch((error: WorkspaceHostCallFailed) =>
        // Surface in the terminal itself: a silent no-op looks like a shell
        // that never printed a prompt.
        reportRequestFailure(error, {
          command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR,
          sessionId,
          message: `Could not start a terminal: ${toErrorMessage(error)}`,
        }),
      ),
    );
  }

  return {
    disposeRendererResources() {
      options.ptyHost.disposeAll();
      options.browserViews.disposeAll();
    },

    followFilesWritten,

    handleMessage(message: DesktopCommandMessage) {
      const parsed = DesktopWorkspaceInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      const data = parsed.data;

      switch (data.command) {
        case DESKTOP_WORKSPACE_COMMANDS.LIST_FILES:
          options.runtime.runFork(listFiles(data.requestId, data.directory));
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.READ_FILE:
          options.runtime.runFork(readFile(data.requestId, data.path));
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE:
          options.runtime.runFork(
            writeFile(data.requestId, data.path, data.contents),
          );
          return true;

        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START:
          options.runtime.runFork(
            startTerminal(
              data.sessionId,
              data.cols,
              data.rows,
              data.initialCommand,
            ),
          );
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT:
          options.ptyHost.get(data.sessionId)?.write(data.data);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE:
          options.ptyHost.get(data.sessionId)?.resize(data.cols, data.rows);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE:
          options.ptyHost.get(data.sessionId)?.dispose();
          return true;

        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN:
          options.browserViews.open(data.tabId, data.url);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS:
          options.browserViews.show(
            data.tabId,
            options.toWindowBounds(data.bounds),
          );
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE:
          options.browserViews.hideAll();
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE:
          options.browserViews.close(data.tabId);
          return true;
      }
    },
  };
}
