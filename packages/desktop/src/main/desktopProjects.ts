// The desktop's open projects: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which project it shows.

import {
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Scope,
  SubscriptionRef,
  type Path,
  type PlatformError,
} from 'effect';

import {
  createAgentResponseTextConnector,
  openSessionEffect,
  type SessionHandle,
} from '@agent/runtime';
import { openProjectStateStore } from '@controllers/session/appStateStore';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { openTexraWorkspaceConfigStore } from '@platform/defaults/nodeStores';
import { openWorktreeStateStore } from '@platform/defaults/worktreeStateStore';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { ProjectDatabases } from '@shared/session/database';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { readSettingFrom } from '@utils/config/platformSettings';
import { absentReason } from '@utils/files/fsEntryExists';
import { DesktopProjectRecords } from './desktopProjectRecords.js';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

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

/** What the window shows and offers, as one value its surfaces follow. */
export interface DesktopProjectsState {
  /** Open projects in the order they were opened; the no-workspace session
   *  is not one. */
  readonly projects: readonly DesktopProject[];
  /** The session key of the project the window shows: an open project's,
   *  or the no-workspace session's. */
  readonly activeKey: string;
  /** Closed projects File > Open Recent offers, the most recently closed
   *  first. */
  readonly recent: readonly string[];
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
  /**
   * The process secret store and global state the helper model behind the
   * latex text-connector resolves against, threaded from the composition root
   * that opened them.
   */
  readonly stores: ModelOptionStores;
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
    FileSystem.FileSystem | Path.Path | ProjectDatabases | ChildProcessSpawner
  >;
  /** The open projects, the shown one and the recent list; every surface
   *  that follows a project switch reads its `changes`. */
  readonly state: SubscriptionRef.SubscriptionRef<DesktopProjectsState>;
  /** Open projects in the order they were opened; the no-workspace session is not one. */
  list(): readonly DesktopProject[];
  /** The project the window shows: the active folder, else the no-workspace session. */
  active(): DesktopProject;
  /** The no-workspace session's project; open for the process lifetime, never in `list()`. */
  fallback(): DesktopProject;
  /** Make an open project the one the window shows, and remember it as such. */
  activate(root: string | undefined): Effect.Effect<void, Error>;
  /**
   * Close an open project: forget it for the next launch (it joins the
   * recent list), stop its runs and wait for them to settle, dispose its
   * session in its own scope, and show the most recently shown remaining
   * project if it was the active one. The other projects' runs are untouched.
   */
  close(root: string): Effect.Effect<void, Error>;
  /** Empty File > Open Recent. */
  clearRecent(): Effect.Effect<void, Error>;
  flushArtifacts(): Effect.Effect<void, Error>;
  /** Dispose every session, the most recently opened first, then the
   *  no-workspace session. */
  dispose(): Effect.Effect<void>;
}

/** The open projects, served to the surfaces that follow them (the dock
 *  badge and notifications) by the startup program that opened them. */
export class DesktopProjects extends Context.Service<
  DesktopProjects,
  DesktopProjectRegistry
>()('@texra/desktop/DesktopProjects') {}

/** The folder paths among `candidates` that are still folders, deduplicated
 *  by canonical root, and the ones that are not. */
const partitionFolders = Effect.fn('desktopProjects.partitionFolders')(
  function* (candidates: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const roots: string[] = [];
    const missing: string[] = [];
    for (const candidate of candidates) {
      const root = canonicalizeWorkspacePath(candidate);
      if (roots.includes(root) || missing.includes(root)) continue;
      const isProject = yield* fs.stat(root).pipe(
        Effect.map((info) => info.type === 'Directory'),
        Effect.catch((error: PlatformError.PlatformError) =>
          absentReason(error)
            ? Effect.succeed(false)
            : Effect.logWarning(
                `Cannot read the remembered project ${root}; forgetting it: ${toErrorMessage(error.reason.cause ?? error)}`,
              ).pipe(Effect.as(false)),
        ),
      );
      (isProject ? roots : missing).push(root);
    }
    return { roots, missing };
  },
);

interface RememberedDesktopProjects {
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
 * The recent list is pruned the same way, silently: nothing asked for those.
 * Both lists are written back whenever that changed them.
 */
export const readRememberedDesktopProjects = Effect.fn(
  'desktopProjects.readRemembered',
)(function* () {
  const records = yield* DesktopProjectRecords;
  const remembered = yield* partitionFolders(yield* records.read);
  const recent = yield* partitionFolders(yield* records.readRecent);
  yield* records.replace(remembered.roots);
  yield* records.replaceRecent(
    recent.roots.filter((root) => !remembered.roots.includes(root)),
  );
  return remembered satisfies RememberedDesktopProjects;
});

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
  yield* runs.stopAll();
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
): Effect.Effect<DesktopProjectRegistry, Error, DesktopProjectRecords> {
  return Effect.gen(function* () {
    const records = yield* DesktopProjectRecords;
    const lanes = new Map<string | symbol, PerKeyLane>();
    const selection = Symbol();
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
    const state = yield* SubscriptionRef.make<DesktopProjectsState>({
      projects: [],
      activeKey: fallback.key,
      recent: yield* records.readRecent,
    });
    const current = () => SubscriptionRef.getUnsafe(state);
    const byRoot = (root: string) =>
      current().projects.find((project) => project.root === root);
    const active = (): DesktopProject =>
      current().projects.find(
        (project) => project.key === current().activeKey,
      ) ?? fallback;
    const syncRecent = Effect.gen(function* () {
      const recent = yield* records.readRecent;
      yield* SubscriptionRef.update(state, (s) => ({ ...s, recent }));
    });
    const activate = (root: string | undefined) =>
      Effect.gen(function* () {
        const next = root === undefined ? undefined : byRoot(root);
        if (next?.root !== undefined) yield* records.activate(next.root);
        const activeKey = (next ?? fallback).key;
        if (activeKey === current().activeKey) return;
        yield* SubscriptionRef.update(state, (s) => ({ ...s, activeKey }));
      }).pipe(withPerKeyLane(lanes, selection));
    return {
      state,
      open(rootInput) {
        const root = canonicalizeWorkspacePath(rootInput);
        return Effect.gen(function* () {
          const existing = byRoot(root);
          if (existing) return existing;
          yield* records.remember(root);
          const storage = resolveWorkspaceStoragePath(options.dataRoot, root);
          const projectScope = yield* Scope.make();
          return yield* Effect.gen(function* () {
            const [workspaceState, workspaceConfig] = yield* Effect.all(
              [
                openProjectStateStore(storage).pipe(
                  Effect.flatMap((projectState) =>
                    openWorktreeStateStore(
                      projectState,
                      options.stores.globalState,
                      root,
                    ),
                  ),
                ),
                openTexraWorkspaceConfigStore(storage, root, (message) =>
                  console.warn(`[desktop] ${message}`),
                ),
              ],
              { concurrency: 'unbounded' },
            );
            const roots = createNodeWorkspaceRoots({
              workspacePath: root,
              storage,
              globalStorage: resolveGlobalStoragePath(options.dataRoot),
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
                  Effect.gen(function* () {
                    const recent = yield* records.readRecent;
                    yield* SubscriptionRef.update(state, (s) => ({
                      ...s,
                      projects: [...s.projects, project],
                      recent,
                    }));
                  }).pipe(withPerKeyLane(lanes, selection)),
                ),
              ),
            );
          }).pipe(
            Scope.provide(projectScope),
            Effect.onError(() =>
              byRoot(root) ? Effect.void : Scope.close(projectScope, Exit.void),
            ),
          );
        }).pipe(withPerKeyLane(lanes, root), Effect.mapError(ensureError));
      },
      list: () => current().projects,
      active,
      fallback: () => fallback,
      activate,
      close(root) {
        return Effect.gen(function* () {
          const project = byRoot(root);
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
                const wasActive = active() === project;
                const remembered = yield* records.read;
                const next =
                  remembered.findLast(
                    (candidate) => candidate !== root && byRoot(candidate),
                  ) ??
                  current().projects.findLast(
                    (candidate) => candidate.root !== root,
                  )?.root;
                yield* records.forget(root, wasActive ? next : undefined);
                const recent = yield* records.readRecent;
                yield* SubscriptionRef.update(state, (s) => ({
                  projects: s.projects.filter(
                    (candidate) => candidate !== project,
                  ),
                  activeKey: wasActive
                    ? (
                        (next === undefined ? undefined : byRoot(next)) ??
                        fallback
                      ).key
                    : s.activeKey,
                  recent,
                }));
                yield* project.dispose();
              }).pipe(withPerKeyLane(lanes, selection));
            }),
          );
        }).pipe(withPerKeyLane(lanes, root), Effect.mapError(ensureError));
      },
      clearRecent: () =>
        records
          .replaceRecent([])
          .pipe(Effect.andThen(syncRecent), Effect.mapError(ensureError)),
      flushArtifacts: () =>
        Effect.gen(function* () {
          const failures: string[] = [];
          for (const project of [fallback, ...current().projects]) {
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
        Effect.suspend(() =>
          current()
            .projects.toReversed()
            .reduce(
              (cleanup, project) =>
                cleanup.pipe(Effect.ensuring(project.dispose())),
              Effect.void,
            ),
        ).pipe(
          Effect.ensuring(fallback.dispose()),
          Effect.ensuring(
            SubscriptionRef.update(state, (s) => ({
              ...s,
              projects: [],
              activeKey: fallback.key,
            })),
          ),
        ),
    } satisfies DesktopProjectRegistry;
  }).pipe(Effect.uninterruptible, Effect.mapError(ensureError));
}
