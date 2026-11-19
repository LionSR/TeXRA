/**
 * The `workspaceFile` host request: the editor pane's directory listing,
 * file read and write-if-unchanged on the session's workspace, plus the agent
 * definitions it opens by catalog name. A path from a surface is untrusted
 * input: `../` traversal or a symlink would otherwise reach anything the user
 * can, so every path is confined to the workspace before touching disk.
 *
 * The workspace's rooted view (`WorkspaceFs`) refuses a path that leaves the
 * root lexically; the real paths of the root and the target then keep a
 * symlink inside the project from leading outside it. The I/O goes to the
 * process `FileSystem` on those canonical paths, which a symlinked root
 * places outside the lexical root the view would accept.
 *
 * A write of a project file runs in the process that holds the project's
 * session, where its tasks write: a window whose project the background
 * service holds sends it there (`file.save`), and the service answers with
 * {@link writeWorkspaceFile}, the write a window makes of a session it holds
 * itself.
 */

// Node imports
import { basename, dirname, join } from 'node:path';

// Third-party imports
import { Effect, FileSystem, type Path, type PlatformError } from 'effect';

// Local imports - harness
import {
  agentKey,
  AGENT_SOURCE,
  isPackagedAgentSource,
  normalizeFilePath,
  Rejected,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import {
  AgentCatalog,
  isPathWithin,
  OFFICE_EXTENSIONS,
  withFileWriteLane,
} from '@texra-ai/harness/host';
import {
  entryTypeIn,
  meansAbsent,
  readDirectoryTypedTolerant,
  readNormalizedFile,
} from '@texra-ai/harness/node';
import { WorkspaceFs } from '@texra-ai/harness/plugins';

// Local imports - server
import type { ServiceLink } from '@texra/controllers/server/client';
import { writeInService } from '@texra/controllers/server/serviceSession';

// Local imports - app
import { FILE_HANDLING_RULES } from '@texra/common/files/fileHandlingRules';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@texra/common/files/fileListingRules';
import {
  agentDocumentIdentity,
  agentDocumentTarget,
  isAgentDocumentTarget,
} from '@texra/shared/agentDocumentTarget';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';

type WorkspaceFileAction = Extract<
  HostCommand,
  { kind: 'workspaceFile' }
>['action'];

/** The editor's save: the path, the contents, and what the editor last read
 *  (`base`). */
type WorkspaceFileWrite = Pick<
  Extract<WorkspaceFileAction, { kind: 'write' }>,
  'path' | 'contents' | 'base'
>;

/** Every containment failure reads the same: which rule refused the path
 *  tells the user nothing they can act on. */
const outsideWorkspace = () =>
  new Rejected({
    reason: 'Only files inside the workspace folder can be opened.',
  });

/** The rooted view's refusal (no folder open, or a path that leaves the
 *  root) is the boundary; any other failure is the filesystem's own. */
const atBoundary = <A, R>(
  self: Effect.Effect<A, PlatformError.PlatformError, R>,
) =>
  self.pipe(
    Effect.catchReason('PlatformError', 'BadArgument', () =>
      Effect.fail(outsideWorkspace()),
    ),
  );

/** `canonicalTarget` when it lies inside `canonicalRoot`; both are real
 *  paths, so neither `..` nor a symlink can carry it out. */
const within = (canonicalRoot: string, canonicalTarget: string) =>
  isPathWithin(canonicalRoot, canonicalTarget)
    ? Effect.succeed(canonicalTarget)
    : Effect.fail(outsideWorkspace());

/** The real path of an existing workspace entry, or the boundary rejection. */
const resolveExisting = Effect.fn('workspaceFileRequest.resolveExisting')(
  function* (inputPath: string) {
    const workspace = yield* WorkspaceFs;
    const [canonicalRoot, canonicalTarget] = yield* Effect.all(
      [workspace.realPath('.'), workspace.realPath(inputPath)],
      { concurrency: 2 },
    ).pipe(atBoundary);
    return yield* within(canonicalRoot, canonicalTarget);
  },
);

/**
 * Where a save of `inputPath` lands, without requiring the file itself to
 * still exist. The canonical parent remains mandatory, so recreating an
 * externally deleted file cannot bypass the workspace or symlink boundary.
 */
const resolveWritable = Effect.fn('workspaceFileRequest.resolveWritable')(
  function* (inputPath: string) {
    const existing = yield* resolveExisting(inputPath).pipe(
      // Absent, and nothing else: a permission or I/O failure on the same
      // call is a real fault and must not read as "not there yet".
      Effect.catchIf(meansAbsent, () => Effect.undefined),
    );
    if (existing !== undefined) return existing;

    const workspace = yield* WorkspaceFs;
    const absolutePath = yield* workspace.resolve(inputPath).pipe(atBoundary);
    // A dangling symlink also makes realPath fail with ENOENT. It must stay
    // rejected: writing through it could create a target outside the
    // workspace. The link-aware probe reports a link as itself (`stat`
    // follows it), and any failure other than "not there" rejects the write.
    if ((yield* entryTypeIn(workspace, absolutePath)) === 'SymbolicLink') {
      return yield* new Rejected({
        reason: 'Symbolic links cannot be recreated by the editor.',
      });
    }
    const [canonicalRoot, canonicalParent] = yield* Effect.all(
      [workspace.realPath('.'), workspace.realPath(dirname(absolutePath))],
      { concurrency: 2 },
    ).pipe(
      Effect.catchIf(meansAbsent, () =>
        Effect.fail(
          new Rejected({
            reason:
              'The file cannot be recreated because its parent folder no longer exists.',
          }),
        ),
      ),
    );
    return yield* within(
      canonicalRoot,
      join(canonicalParent, basename(absolutePath)),
    );
  },
);

/** An agent definition the editor names by catalog identity, resolved afresh
 *  on each read and save (also after a restart), so a removed definition
 *  keeps no old file grant alive and a surface never names a file by an
 *  absolute path. */
const resolveAgentDocument = Effect.fn('workspaceFileRequest.agentDocument')(
  function* (target: string, write: boolean) {
    const identity = agentDocumentIdentity(target);
    const entry =
      identity &&
      (yield* AgentCatalog).get(agentKey(identity.source, identity.name));
    if (!entry?.path) {
      return yield* new Rejected({
        reason:
          'This agent definition is no longer available. Open its current definition from Settings.',
      });
    }
    if (write && isPackagedAgentSource(entry.source)) {
      return yield* new Rejected({
        reason:
          'Built-in and plugin definitions are read-only. Customize the agent to edit a copy.',
      });
    }
    return entry.path;
  },
);

/** The editor target of the agent definition at `filePath`, the settings
 *  body having already resolved it; shadowed packaged definitions count, so
 *  "View built-in" still opens the original. */
export const agentDocumentForPath = (filePath: string) =>
  Effect.map(AgentCatalog, (catalog) => {
    for (const item of catalog.list()) {
      for (const source of Object.values(AGENT_SOURCE)) {
        const entry = catalog.get(agentKey(source, item.name));
        if (entry?.path === filePath) {
          return agentDocumentTarget(source, entry.name);
        }
      }
    }
    return undefined;
  });

/**
 * One directory of the project tree. The tree is a code editor, not the
 * agent input picker: it shares the ignore policy but not the picker's
 * `.ts`/`.js`/`.json` exclusions, and hides only known binary media and
 * office formats. A symlink is not listed: its target is either a second
 * entry for a file already in the tree or outside the project.
 */
const listDirectory = Effect.fn('workspaceFileRequest.listDirectory')(
  function* (requested: string) {
    const root = (yield* WorkspaceFs).root;
    if (root === undefined) return [];
    const directory = normalizeFilePath(requested)
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
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
      ? yield* resolveExisting(directory)
      : root;
    // The typed listing reports a link as itself, where `stat` would follow
    // it. The tolerant form drops an entry whose type cannot be read
    // (warn-logged) rather than failing the tree.
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

/**
 * A save lands only while the file still holds what the editor last read
 * (`base`); a run that rewrote it meanwhile is answered `changedOnDisk`, and
 * the editor asks whether to overwrite or reload. The check and the write
 * hold the file's write lane, which an approved edit run in this process
 * holds too, so neither lands between the other's check and write. The lane
 * is per process, so this runs in the process whose tasks write the file
 * ({@link answerWorkspaceFile} sends it there). A file gone since the read
 * is recreated, as a deleted file always was. Saves of one file arrive one
 * at a time: the editor waits for each answer. Every failure is `Rejected`,
 * a filesystem failure in its own words.
 */
export const writeWorkspaceFile = Effect.fn('writeWorkspaceFile')(
  function* ({ path: target, contents, base }: WorkspaceFileWrite) {
    const fs = yield* FileSystem.FileSystem;
    const absolutePath = yield* isAgentDocumentTarget(target)
      ? resolveAgentDocument(target, true)
      : resolveWritable(target);
    return yield* Effect.gen(function* () {
      if (base !== null) {
        const onDisk = yield* readNormalizedFile(fs, absolutePath).pipe(
          Effect.catchIf(meansAbsent, () => Effect.succeed(null)),
        );
        if (onDisk !== null && onDisk !== base)
          return { kind: 'changedOnDisk' } as const;
      }
      yield* fs.writeFileString(absolutePath, contents);
      return { kind: 'done' } as const;
    }).pipe(withFileWriteLane(absolutePath));
  },
  Effect.catchTag('PlatformError', (error) =>
    Effect.fail(new Rejected({ reason: toErrorMessage(error) })),
  ),
);

const readFile = Effect.fn('workspaceFileRequest.readFile')(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const absolutePath = yield* isAgentDocumentTarget(target)
    ? resolveAgentDocument(target, false)
    : resolveExisting(target);
  // LF-only with a UTF-8 BOM kept, so the editor's verbatim save keeps it.
  const contents = yield* readNormalizedFile(fs, absolutePath);
  return { kind: 'contents', contents } satisfies HostOutcome;
});

/**
 * Answer one `workspaceFile` action on the session's workspace. Every
 * failure is the request's `Rejected` answer, which the editor shows: a
 * filesystem failure in its own words. `service` is the link of a window
 * whose project the background service holds: its save of a project file
 * is the service's write, so it shares the write lane of the tasks' edits,
 * and this process's only while the link is away. An agent definition is
 * written here either way: this process's catalog named the file the
 * editor shows.
 */
export const answerWorkspaceFile = Effect.fn('answerWorkspaceFile')(
  function* (
    action: WorkspaceFileAction,
    service?: ServiceLink,
  ): Effect.fn.Return<
    HostOutcome,
    Rejected | PlatformError.PlatformError,
    WorkspaceFs | FileSystem.FileSystem | Path.Path | AgentCatalog
  > {
    switch (action.kind) {
      case 'list':
        return {
          kind: 'entries',
          entries: yield* listDirectory(action.directory),
        };
      case 'read':
        return yield* readFile(action.path);
      case 'write': {
        const { path, contents, base } = action;
        const { root } = yield* WorkspaceFs;
        return yield* service === undefined ||
        root === undefined ||
        isAgentDocumentTarget(path)
          ? writeWorkspaceFile(action)
          : writeInService(
              service,
              path,
              (client) =>
                client['file.save']({ workspace: root, path, contents, base }),
              writeWorkspaceFile(action),
            );
      }
    }
  },
  Effect.catchTag('PlatformError', (error) =>
    Effect.fail(new Rejected({ reason: toErrorMessage(error) })),
  ),
);
