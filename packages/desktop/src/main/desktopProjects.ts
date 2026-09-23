// The desktop's open projects: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which project it shows.

import { stat } from 'node:fs/promises';

import { Data, Effect, Exit, Scope, type FileSystem, type Path } from 'effect';

import {
  createAgentResponseTextConnector,
  openSessionEffect,
  type SessionHandle,
} from '@agent/runtime';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { openProjectStateStore } from '@controllers/session/appStateStore';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { openTexraWorkspaceConfigStore } from '@platform/defaults/nodeStores';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { ProjectDatabases } from '@shared/session/database';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { readSettingFrom } from '@utils/config/platformSettings';
import type { DesktopProjectRecords } from './desktopProjectRecords.js';

import type { DesktopProjectsMessage } from '../shared/desktopProjectMessages.js';

export interface DesktopProject {
  /** The session key: the storage root the fold's `SessionView.key`
   *  carries, and the project's name on every renderer message. */
  readonly key: string;
  /** Canonical folder path, or undefined for the no-workspace session. */
  readonly root: string | undefined;
  readonly roots: WorkspaceRoots;
  readonly session: SessionHandle;
  /** Release the session from its owner; settles once its entry has unwound. */
  dispose(): Effect.Effect<void>;
}

interface DesktopProjectRegistryOptions {
  /** Desktop data root (`~/.texra` in production, the e2e profile otherwise). */
  readonly dataRoot: string;
  /** Roots of the no-workspace session; the process roots. */
  readonly processRoots: WorkspaceRoots;
  /** The fallback project owns its state and session through this one scope. */
  readonly processScope: Scope.Closeable;
  /**
   * The one store over the global config file, shared by every project's
   * config provider: a `JsonStore` serves reads from its own open-time view,
   * so a second instance over the same file would not see a global setting
   * another project changed until the next launch.
   */
  readonly globalConfigStore: ConfigStore;
  readonly records: DesktopProjectRecords;
  /**
   * The process secret store and global state the helper model behind the
   * latex text-connector resolves against, threaded from the composition root
   * that opened them.
   */
  readonly stores: ModelOptionStores;
  warn(message: string): void;
}

export interface DesktopProjectRegistry {
  /**
   * Open a folder as a project, remember it for the next launch, or return
   * the one already open. Its stores read through the process runtime's
   * `FileSystem` and `Path`, so it runs where those are provided.
   */
  open(
    root: string,
  ): Effect.Effect<
    DesktopProject,
    Error,
    FileSystem.FileSystem | Path.Path | ProjectDatabases
  >;
  /** Open projects in the order they were opened; the no-workspace session is not one. */
  list(): readonly DesktopProject[];
  /** The project the window shows: the active folder, else the no-workspace session. */
  active(): DesktopProject;
  /** The no-workspace session's project; open for the process lifetime, never in `list()`. */
  fallback(): DesktopProject;
  /** Make an open project the one the window shows, and remember it as such. */
  activate(root: string | undefined): Effect.Effect<void, Error>;
  /**
   * Close an open project: forget it for the next launch, stop its runs and
   * wait for them to settle, dispose its session in its own scope, and show
   * the most recently shown remaining project if it was the active one. The
   * other projects' runs are untouched.
   */
  close(root: string): Effect.Effect<void, Error>;
  summary(): Omit<DesktopProjectsMessage, 'command'>;
  /** Fires after a project opens or closes, or the active project changes. */
  onChange(listener: () => void): () => void;
  flushArtifacts(): Effect.Effect<void, Error>;
  /** Dispose every session, the most recently opened first, then the
   *  no-workspace session. */
  dispose(): Effect.Effect<void>;
}

export interface RememberedDesktopProjects {
  /** Canonical roots to reopen, the one to show last. */
  readonly roots: readonly string[];
  /** Remembered roots whose folder no longer exists; forgotten. */
  readonly missing: readonly string[];
}

/**
 * The folders to reopen at launch: the remembered list, deduplicated by
 * canonical root, with entries that are no longer a folder dropped (a
 * remembered path that a regular file has since replaced is not a project
 * either, nor is one that cannot be read at all: permissions, a dead mount).
 * The list is written back whenever that changed it.
 */
export function readRememberedDesktopProjects(
  records: DesktopProjectRecords,
  warn: (message: string) => void,
): Effect.Effect<RememberedDesktopProjects, Error> {
  return Effect.gen(function* () {
    const stored = yield* records.read;
    const roots: string[] = [];
    const missing: string[] = [];
    for (const candidate of stored) {
      const root = canonicalizeWorkspacePath(candidate);
      if (roots.includes(root) || missing.includes(root)) continue;
      const stats = yield* Effect.tryPromise({
        try: () => stat(root),
        catch: ensureError,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!isFileNotFoundError(error) && !isNotADirectoryError(error)) {
              warn(
                `Cannot read the remembered project ${root}; forgetting it: ${toErrorMessage(error)}`,
              );
            }
            return undefined;
          }),
        ),
      );
      (stats?.isDirectory() ? roots : missing).push(root);
    }
    yield* records.replace(roots);
    return { roots, missing };
  });
}

/**
 * Stop every run the project still owns and wait for their drivers to settle
 * them (CANCELLED, flow record preserved for a later resume), so the session
 * is disposed with nothing executing under it: `RunRegistry.dispose`
 * clears its handles without interrupting them, and a run left driving after
 * that would continue with no presentation and no stop control. Only roots
 * are killed; the stop cascades into their children. Unbounded on purpose: a
 * tool that ignores its kill is the same problem the process exit drain has,
 * and the project stays open, stoppable and visible in the log, until it ends.
 */
/**
 * Stopping a closing project's runs faulted. The stop is uninterruptible and
 * its failure leaves the project's owner with the host, so the close reports
 * this rather than dropping the project from the registry.
 */
class ProjectRunsNotStopped extends Data.TaggedError('ProjectRunsNotStopped')<{
  readonly root: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const stopProjectRuns = Effect.fn('desktopProjects.stopProjectRuns')(function* (
  session: SessionHandle,
) {
  const { runs } = session;
  yield* Effect.all(runs.stopAll(), {
    concurrency: 'unbounded',
    discard: true,
  });
  yield* runs.awaitDrained();
});

/**
 * Open one session over `roots`. Every fact this project's services answer
 * with comes from `roots` as data — the approval policy below, and the latex
 * text-join helper bound here against this project's roots, so a workspace
 * override in `.texra/config.json` is the same value a run in this session
 * would read.
 */
function openProjectSession(
  root: string | undefined,
  roots: WorkspaceRoots,
  secrets: PlatformSecrets,
): Effect.Effect<DesktopProject, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const session = yield* Effect.acquireRelease(
      openSessionEffect({
        roots,
        responseTextProcessing: createTexraResponseTextProcessing(
          // This project's own roots, plus the process secret store — not the
          // process-level stores, which carry no workspace config layer and so
          // answered every project with the global value (#12773). Taking
          // `secrets` alone rather than a whole `ModelOptionStores` is what
          // makes the wrong pair unrepresentable here.
          createAgentResponseTextConnector({ ...roots, secrets }),
        ),
      }),
      (session) => session.dispose(),
    );
    session.setApprovalPolicy(
      yield* readSettingFrom<TexraApprovalPolicy>(
        roots,
        TEXRA_APPROVAL_POLICY_CONFIG_KEY,
      ),
    );
    return {
      key: roots.storage,
      root,
      roots,
      session,
      dispose: () => Scope.close(scope, Exit.void),
    };
  });
}

/**
 * Build the registry with its no-workspace session open, so a window always
 * has a session to show even before the first folder opens.
 */
export function openDesktopProjectRegistry(
  options: DesktopProjectRegistryOptions,
): Effect.Effect<DesktopProjectRegistry, Error> {
  return Effect.gen(function* () {
    const projects = new Map<string, DesktopProject>();
    const lanes = new Map<string | symbol, PerKeyLane>();
    const selection = Symbol();
    const listeners = new Set<() => void>();
    let activeRoot: string | undefined;
    const fallback = yield* Effect.uninterruptible(
      openProjectSession(
        undefined,
        options.processRoots,
        options.stores.secrets,
      ).pipe(
        Scope.provide(options.processScope),
        Effect.onError(() => Scope.close(options.processScope, Exit.void)),
      ),
    );
    const notify = () => {
      for (const listener of [...listeners]) listener();
    };
    const openProjects = () => [...projects.values()];
    const active = (): DesktopProject =>
      (activeRoot === undefined ? undefined : projects.get(activeRoot)) ??
      fallback;
    const activate = (root: string | undefined) =>
      Effect.gen(function* () {
        const next =
          root !== undefined && projects.has(root) ? root : undefined;
        if (next !== undefined) yield* options.records.activate(next);
        if (next === activeRoot) return;
        activeRoot = next;
        notify();
      }).pipe(withPerKeyLane(lanes, selection));
    return {
      open(rootInput) {
        const root = canonicalizeWorkspacePath(rootInput);
        return Effect.gen(function* () {
          const existing = projects.get(root);
          if (existing) return existing;
          yield* options.records.remember(root);
          const storageProvider = new WorkspaceStorageProvider(
            options.dataRoot,
            root,
          );
          const storage = storageProvider.getStoragePath();
          const projectScope = yield* Scope.make();
          return yield* Effect.gen(function* () {
            const [workspaceState, workspaceConfig] = yield* Effect.all(
              [
                openProjectStateStore(storage),
                openTexraWorkspaceConfigStore(storage, root, options.warn),
              ],
              { concurrency: 'unbounded' },
            );
            const roots = createNodeWorkspaceRoots({
              workspacePath: root,
              storage,
              globalStorage: storageProvider.getGlobalStoragePath(),
              config: {
                workspace: workspaceConfig,
                global: options.globalConfigStore,
              },
              workspaceState,
              globalState: options.stores.globalState,
            });
            // Acquire the session and install its registry owner before
            // interruption can leave this operation.
            return yield* Effect.uninterruptible(
              openProjectSession(root, roots, options.stores.secrets).pipe(
                Effect.tap((project) =>
                  Effect.sync(() => {
                    projects.set(root, project);
                    notify();
                  }).pipe(withPerKeyLane(lanes, selection)),
                ),
              ),
            );
          }).pipe(
            Scope.provide(projectScope),
            Effect.onError(() =>
              projects.has(root)
                ? Effect.void
                : Scope.close(projectScope, Exit.void),
            ),
          );
        }).pipe(withPerKeyLane(lanes, root), Effect.mapError(ensureError));
      },
      list: openProjects,
      active,
      fallback: () => fallback,
      activate,
      close(root) {
        return Effect.gen(function* () {
          const project = projects.get(root);
          if (!project) return;
          // Stop while the registry still owns the project. A failed stop or
          // persistence operation leaves that owner available to the host.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* stopProjectRuns(project.session).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectRunsNotStopped({
                      root,
                      message: `The project's runs could not be stopped: ${toErrorMessage(cause)}`,
                      cause,
                    }),
                ),
              );
              yield* Effect.gen(function* () {
                const remembered = yield* options.records.read;
                const next =
                  remembered.findLast(
                    (candidate) =>
                      candidate !== root && projects.has(candidate),
                  ) ??
                  openProjects().findLast(
                    (candidate) => candidate.root !== root,
                  )?.root;
                yield* options.records.forget(
                  root,
                  activeRoot === root ? next : undefined,
                );
                projects.delete(root);
                if (activeRoot === root) activeRoot = next;
                notify();
                yield* project.dispose();
              }).pipe(withPerKeyLane(lanes, selection));
            }),
          );
        }).pipe(withPerKeyLane(lanes, root), Effect.mapError(ensureError));
      },
      summary: () => ({
        projects: openProjects().flatMap((project) =>
          project.root === undefined
            ? []
            : [{ key: project.key, root: project.root }],
        ),
        activeKey: active().key,
      }),
      onChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      flushArtifacts: () =>
        Effect.gen(function* () {
          const failures: string[] = [];
          for (const project of [fallback, ...projects.values()]) {
            yield* project.session.settlePublications().pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  failures.push(
                    `${project.root ?? 'no workspace'}: ${toErrorMessage(error)}`,
                  );
                }),
              ),
            );
          }
          if (failures.length > 0)
            return yield* Effect.fail(
              new Error(
                `Failed to flush desktop session artifacts: ${failures.join('; ')}`,
              ),
            );
        }),
      dispose: () =>
        [...projects.values()]
          .toReversed()
          .reduce(
            (cleanup, project) =>
              cleanup.pipe(Effect.ensuring(project.dispose())),
            Effect.void,
          )
          .pipe(
            Effect.ensuring(fallback.dispose()),
            Effect.ensuring(Effect.sync(() => projects.clear())),
          ),
    } satisfies DesktopProjectRegistry;
  }).pipe(Effect.uninterruptible, Effect.mapError(ensureError));
}
