// Main-process IPC for the workspace shell surfaces: editor file I/O, terminal
// pty sessions, and embedded browser tabs. All three are renderer-driven, and
// the sandboxed renderer has no node integration, so every request lands here.
// Requests are schema-validated at the boundary and, for file I/O, confined to the
// workspace root before touching disk: a renderer path is untrusted input, and
// `../` traversal would otherwise reach anything the user can.
//
// Every disk operation below is a program over the standard library's
// `FileSystem`, which the window's router runs and reports. The paths are the
// canonical ones the containment check vouched for, which a workspace symlink
// can place outside the lexical root, so they go to the process filesystem,
// not a root-confined view that would refuse them.

import { basename, dirname, join } from 'node:path';
import { normalizeFilePath, toErrorMessage } from '@texra-ai/harness/schemas';

import { Effect, FileSystem, type PlatformError, Schema } from 'effect';

import { Rejected } from '@texra-ai/harness';
import {
  isPathWithin,
  OFFICE_EXTENSIONS,
  pathToLocationIn,
  withPerKeyLane,
  type PerKeyLane,
} from '@texra-ai/harness/host';
import {
  entryTypeIn,
  readDirectoryTypedTolerant,
} from '@texra-ai/harness/node';
import { onAppSignal } from '@eventBus/AppSignals';
import { FILE_HANDLING_RULES } from '@texra/common/files/fileHandlingRules';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@texra/common/files/fileListingRules';

import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopBrowserBounds,
  type DesktopWorkspaceInboundMessage,
  type DesktopWorkspaceReply,
} from '../shared/desktopWorkspaceMessages.js';
import {
  AgentDocumentUnavailable,
  resolveAgentDocument,
} from './desktopAgentDocuments.js';
import type { ProcessServices } from '@texra-ai/harness/host';
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
}

interface DesktopWorkspaceIpc {
  /** The editor pane's file I/O: one `host.request` program per action. */
  file(
    action: Extract<HostRequest, { kind: 'workspaceFile' }>['action'],
  ): Effect.Effect<HostOutcome, Rejected, ProcessServices>;

  /** The program one parsed renderer request runs. */
  handle(
    message: DesktopWorkspaceInboundMessage,
  ): Effect.Effect<void, Error, ProcessServices>;

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
class WorkspaceRequestRefused extends Schema.TaggedError<WorkspaceRequestRefused>()(
  'WorkspaceRequestRefused',
  {
    message: Schema.String,
  },
) {}

/**
 * A host promise this handler awaited rejected. `member` names which, so the
 * report says what actually failed, and `message` is the rejection's own text
 * so the sentence the renderer shows is unchanged.
 */
class WorkspaceHostCallFailed extends Schema.TaggedError<WorkspaceHostCallFailed>()(
  'WorkspaceHostCallFailed',
  {
    member: Schema.Literal('ptyHost.create'),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Everything a file-I/O program here can fail with. */
type WorkspaceFileFailure =
  | WorkspaceRequestRefused
  | AgentDocumentUnavailable
  | PlatformError.PlatformError;

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
  // With no folder open every path is outside it.
  const located = root ? pathToLocationIn(root, inputPath) : undefined;
  if (!root || located?.kind !== 'workspace') {
    return Effect.fail(
      new WorkspaceRequestRefused({ message: WORKSPACE_BOUNDARY_ERROR }),
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
  // The link-aware probe reports a link as itself — `stat` follows it — and
  // any failure other than "not there" refuses the write instead of reading
  // as "no link here".
  const entryType = yield* entryTypeIn(fs, absolutePath);
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
  renderer: { postToRenderer(message: DesktopWorkspaceReply): void },
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

  const listDirectory = Effect.fn('desktopWorkspaceIpc.listDirectory')(
    function* (directory: string) {
      const root = options.getWorkspacePath();
      if (!root) return [];

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
      return entries
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
    },
  );

  const listFiles = (directory: string) =>
    listDirectory(
      normalizeFilePath(directory).replace(/^\.\//, '').replace(/\/$/, ''),
    ).pipe(
      Effect.map((entries): HostOutcome => ({ kind: 'entries', entries })),
    );

  // The editor's buffers are LF-only, as every read of a workspace file
  // through the shared facade this replaces already was. Decoding the bytes
  // ourselves keeps a UTF-8 BOM, which `readFileString`'s decoder strips and
  // the editor's verbatim save would otherwise delete.
  const editorText = (fs: FileSystem.FileSystem, absolutePath: string) =>
    fs
      .readFile(absolutePath)
      .pipe(
        Effect.map((bytes) =>
          Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n'),
        ),
      );

  const readFile = (path: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const absolutePath = yield* path.startsWith('texra-agent:')
        ? resolveAgentDocument(path, false)
        : resolveWorkspacePath(options.getWorkspacePath(), path);
      const contents = yield* editorText(fs, absolutePath);
      return { kind: 'contents', contents } satisfies HostOutcome;
    });

  // One save of a file at a time. Each save is its own request fiber, so v5's
  // write could otherwise land after v6's and leave v5 on disk while the tab
  // reads clean. The lane is keyed by the request's path and claimed before
  // resolving it: keyed by the asynchronous canonical path, the later save
  // could resolve first and overtake.
  //
  // The disk is the one owner of what the file holds: a save carries what
  // the editor last read (`base`) and lands only while the file still holds
  // it, checked on the same lane as the write. A run that rewrote the file
  // meanwhile is answered `changedOnDisk` instead of overwritten; the
  // editor asks whether to overwrite or reload. A file gone since the read
  // is recreated, as a deleted file always was.
  const writeLanes = new Map<string, PerKeyLane>();
  const writeFile = (path: string, contents: string, base: string | null) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const absolutePath = yield* path.startsWith('texra-agent:')
        ? resolveAgentDocument(path, true)
        : resolveWorkspaceWritePath(options.getWorkspacePath(), path);
      if (base !== null) {
        const onDisk = yield* editorText(fs, absolutePath).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === 'NotFound',
            () => Effect.succeed(null),
          ),
        );
        if (onDisk !== null && onDisk !== base)
          return { kind: 'changedOnDisk' } satisfies HostOutcome;
      }
      yield* fs.writeFileString(absolutePath, contents);
      return { kind: 'done' } satisfies HostOutcome;
    }).pipe(withPerKeyLane(writeLanes, path));

  /** A refused file request is the request's answer: the editor pane shows
   *  it. */
  const refuse = Effect.mapError(
    (error: WorkspaceFileFailure) =>
      new Rejected({ reason: toErrorMessage(error) }),
  );

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
      // Surface in the terminal itself: a silent no-op looks like a shell
      // that never printed a prompt. Then fail with the cause, so the
      // window's router reports it and the request never settles in silence.
      Effect.catch((error: WorkspaceHostCallFailed) =>
        Effect.andThen(
          Effect.sync(() =>
            renderer.postToRenderer({
              command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR,
              sessionId,
              message: `Could not start a terminal: ${toErrorMessage(error)}`,
            }),
          ),
          Effect.fail(error),
        ),
      ),
    );
  }

  return {
    disposeRendererResources() {
      options.ptyHost.disposeAll();
      options.browserViews.disposeAll();
    },

    followFilesWritten,

    file(action) {
      switch (action.kind) {
        case 'list':
          return refuse(listFiles(action.directory));
        case 'read':
          return refuse(readFile(action.path));
        case 'write':
          return refuse(writeFile(action.path, action.contents, action.base));
      }
    },

    handle(data) {
      switch (data.command) {
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START:
          return startTerminal(
            data.sessionId,
            data.cols,
            data.rows,
            data.initialCommand,
          );
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.write(data.data);
          });
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.resize(data.cols, data.rows);
          });
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.dispose();
          });

        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN:
          return Effect.sync(() => {
            options.browserViews.open(data.tabId, data.url);
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS:
          return Effect.sync(() => {
            options.browserViews.show(
              data.tabId,
              options.toWindowBounds(data.bounds),
            );
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE:
          return Effect.sync(() => {
            options.browserViews.hideAll();
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE:
          return Effect.sync(() => {
            options.browserViews.close(data.tabId);
          });
      }
    },
  };
}
