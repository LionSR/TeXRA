// The desktop's open projects: one `Session` per open folder, each rooted in
// that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. A folder's session is the background
// service's while the app is its client; only the no-workspace session, and
// every session when there is no service, is opened here. Opening a second folder no longer relaunches
// the process; the window switches which project it shows.

import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Result,
  Scope,
  SubscriptionRef,
  type Path,
} from 'effect';

import { type LocalSession, type Session, Sessions } from '@texra-ai/harness';
import {
  SessionHostInteractions,
  withPerKeyLane,
  type PerKeyLane,
  StateStores,
} from '@texra-ai/harness/host';
import {
  absentReason,
  createNodeWorkspaceRoots,
  canonicalizeWorkspacePath,
  resolveWorkspaceStoragePath,
} from '@texra-ai/harness/node';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { openTexraWorkspaceConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  projectDisplayOf,
  type ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import {
  serviceProjectState,
  serviceSession,
} from '@texra/controllers/server/serviceSession';
import type { ServiceLink } from '@texra/controllers/server/client';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import type { WindowClient } from '@texra/controllers/server/windowHost';
import { recordFirstCompletedRun } from '@texra/controllers/onboarding/onboardingFunnel';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import { DesktopProjectRecords } from './desktopProjectRecords.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';
import type { ConfigStore } from '@texra-ai/harness/node';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

interface DesktopProjectFacts {
  /** The session key: the storage root the fold's `SessionView.key`
   *  carries, and the project's name on every renderer message. */
  readonly key: string;
  /** Canonical folder path, or undefined for the no-workspace session. */
  readonly root: string | undefined;
  /** What the rail, the snapshot, notifications, and the window title print
   *  for it, derived once from `key` and `root`. */
  readonly display: ProjectDisplay;
  readonly roots: WorkspaceRoots;
  /** Where a failure this window meets before a run opens, and a run's
   *  final output, are presented: the local session, or the window's own
   *  host, which its run wiring attaches. */
  readonly present: Pick<SessionHostInteractions, 'emit'>;
  /** Release the session from its owner; settles once its entry has unwound. */
  dispose(): Effect.Effect<void>;
}

/** An open project: its session opened here, or the service's, which
 *  this process holds no store, run or claim of. */
export type DesktopProject = DesktopProjectFacts &
  (
    | {
        readonly session: LocalSession;
        readonly service?: undefined;
        /** What the window attaches through: this process's windows. */
        readonly link: ServiceLink<WindowClient>;
      }
    | {
        /** Where this project's runs run: the background service. */
        readonly session: Session;
        readonly service: ServiceLink;
        readonly root: string;
        readonly present: SessionHostInteractions;
      }
  );

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
  /** The background service, when the app is its client: a folder's
   *  runs run there. */
  readonly service: ServiceLink | undefined;
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
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
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
   * recent list), close its session in its own scope (its runs stopped and
   * settled under the shutdown deadline), and show the most recently shown remaining
   * project if it was the active one. The other projects' runs are untouched.
   */
  close(root: string): Effect.Effect<void, Error>;
  /** Empty File > Open Recent. */
  clearRecent(): Effect.Effect<void, Error>;
  /** Close every session, the most recently opened first, then the
   *  no-workspace session. */
  dispose(): Effect.Effect<void>;
}

/** The open projects, served to the surfaces that follow them (the dock
 *  badge and notifications) by the startup program that opened them. */
export class DesktopProjects extends Context.Service<
  DesktopProjects,
  DesktopProjectRegistry
>()('@texra/desktop/DesktopProjects') {}

/** The folder paths among `candidates`, deduplicated by canonical root, split
 *  three ways: still folders, gone (or no longer a folder), and unreadable
 *  (the stat itself failed: permissions, a dead mount). `kept` is the roots
 *  and the unreadable ones in their remembered order, which is what storage
 *  keeps: a folder that could not be read this launch is not known to be gone. */
const partitionFolders = Effect.fn('desktopProjects.partitionFolders')(
  function* (candidates: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const roots: string[] = [];
    const missing: string[] = [];
    const unreadable: { readonly root: string; readonly reason: string }[] = [];
    const kept: string[] = [];
    // Dedupe first, stat the roots at once, then sort the results in the
    // remembered order.
    const unique = [...new Set(candidates.map(canonicalizeWorkspacePath))];
    const stats = yield* Effect.forEach(
      unique,
      (root) => fs.stat(root).pipe(Effect.result),
      { concurrency: 8 },
    );
    for (const [index, root] of unique.entries()) {
      const stat = stats[index];
      if (Result.isSuccess(stat)) {
        if (stat.success.type === 'Directory') {
          roots.push(root);
          kept.push(root);
        } else {
          missing.push(root);
        }
      } else if (absentReason(stat.failure)) {
        missing.push(root);
      } else {
        const reason = toErrorMessage(
          stat.failure.reason.cause ?? stat.failure,
        );
        yield* Effect.logWarning(
          `Cannot read the remembered project ${root}; keeping it for the next launch: ${reason}`,
        );
        unreadable.push({ root, reason });
        kept.push(root);
      }
    }
    return { roots, missing, unreadable, kept };
  },
);

interface RememberedDesktopProjects {
  /** Canonical roots to reopen, the one to show last. */
  readonly roots: readonly string[];
  /** Remembered roots whose folder no longer exists; forgotten. */
  readonly missing: readonly string[];
  /** Remembered roots that could not be read; not opened, still remembered. */
  readonly unreadable: readonly {
    readonly root: string;
    readonly reason: string;
  }[];
}

/**
 * The folders to reopen at launch: the remembered list, deduplicated by
 * canonical root, with entries that are no longer a folder dropped (a
 * remembered path that a regular file has since replaced is not a project
 * either). One that cannot be read at all (permissions, a dead mount) is not
 * opened but stays remembered, since nothing says it is gone. The recent list
 * is pruned the same way, silently: nothing asked for those. Both lists are
 * written back whenever that changed them.
 */
export const readRememberedDesktopProjects = Effect.fn(
  'desktopProjects.readRemembered',
)(function* () {
  const records = yield* DesktopProjectRecords;
  // The two lists are independent, so they are read and checked at once.
  const [remembered, recent] = yield* Effect.all(
    [
      Effect.flatMap(records.read, partitionFolders),
      Effect.flatMap(records.readRecent, partitionFolders),
    ],
    { concurrency: 'unbounded' },
  );
  yield* records.replace(remembered.kept);
  yield* records.replaceRecent(
    recent.kept.filter((root) => !remembered.kept.includes(root)),
  );
  return {
    roots: remembered.roots,
    missing: remembered.missing,
    unreadable: remembered.unreadable,
  } satisfies RememberedDesktopProjects;
});

/** Show `message` in a warning dialog, unawaited: a dialog that cannot be
 *  shown is logged, with the message it carried. */
const warnInDialog = (message: string): void => {
  showDesktopWarningDialog(message).catch((error: unknown) =>
    console.warn(
      `[desktop] A warning dialog could not be shown (${toErrorMessage(error)}): ${message}`,
    ),
  );
};

/**
 * Open one session over `roots`. Every fact this project's services answer
 * with comes from `roots` as data — the approval policy below — so a
 * workspace override in `.texra/config.json` is the same value a run in this
 * session would read.
 */
function openProjectSession(
  root: string | undefined,
  roots: WorkspaceRoots,
  // The closeable scope the caller provides; `dispose` closes it.
  scope: Scope.Closeable,
  service: ServiceLink | undefined,
  sessions: Sessions['Service'],
  hosts: Context.Service.Shape<typeof HostWindows>,
): Effect.Effect<DesktopProject, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const facts = {
      key: roots.storage,
      display: projectDisplayOf(roots.storage, root),
      roots,
      dispose: () => Scope.close(scope, Exit.void),
    };
    // A folder's runs run in the service, which follows its interrupted
    // tasks; this process opens no session for it.
    if (service !== undefined && root !== undefined)
      return {
        ...facts,
        root,
        service,
        session: yield* serviceSession(service, root, roots),
        // Disposed with the project, its window's attachment with it.
        present: yield* Effect.acquireRelease(
          Effect.sync(() => new SessionHostInteractions()),
          (present) => present.dispose(),
        ),
      };
    // The no-workspace session's runs, and every run without a service, run
    // here.
    const session = yield* Effect.acquireRelease(
      sessions.open(roots, {
        persistent: true,
        host: { interruptedTasks: 'offer' },
      }),
      // The one close every session takes: its runs stopped under the
      // shutdown deadline, the ones still live past it settled, its
      // artifacts flushed, its entry released.
      (opened) => Effect.asVoid(sessions.close(opened.roots)),
    );
    yield* recordFirstCompletedRun(session);
    // A store moved aside at open (pre-1.0 or corrupt) is said once, as the
    // extension and the CLI say it.
    if (session.storeMovedAside)
      warnInDialog(sessionStoreMovedAsideMessage(session.storeMovedAside));
    return {
      ...facts,
      root,
      session,
      present: session,
      link: yield* hosts.localLink(session),
    };
  });
}

/**
 * Build the registry with its no-workspace session open, so a window always
 * has a session to show even before the first folder opens.
 */
export function openDesktopProjectRegistry(
  options: DesktopProjectRegistryOptions,
): Effect.Effect<
  DesktopProjectRegistry,
  Error,
  DesktopProjectRecords | StateStores | Sessions | HostWindows
> {
  return Effect.gen(function* () {
    // The process's sessions: each project's session is opened through them.
    const sessions = yield* Sessions;
    const hosts = yield* HostWindows;
    const records = yield* DesktopProjectRecords;
    const stateStores = yield* StateStores;
    const lanes = new Map<string | symbol, PerKeyLane>();
    const selection = Symbol();
    const fallback = yield* Effect.uninterruptible(
      openProjectSession(
        undefined,
        options.processRoots,
        options.processScope,
        undefined,
        sessions,
        hosts,
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
    // On the selection lane, as every other write of `recent`: a read taken
    // before another's write must not land after it.
    const syncRecent = Effect.gen(function* () {
      const recent = yield* records.readRecent;
      yield* SubscriptionRef.update(state, (s) => ({ ...s, recent }));
    }).pipe(withPerKeyLane(lanes, selection));
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
            const [workspaceState, repoState, workspaceConfigs] =
              yield* Effect.all(
                [
                  // A folder of the service keeps its state there: this
                  // process opens no store of that project.
                  options.service !== undefined
                    ? Effect.succeed(serviceProjectState(options.service, root))
                    : stateStores.project(storage, root),
                  stateStores.repo(storage, root),
                  openTexraWorkspaceConfigStores(
                    TEXRA_SETTINGS,
                    storage,
                    root,
                    (message) => {
                      console.warn(`[desktop] ${message}`);
                      warnInDialog(message);
                    },
                  ),
                ],
                { concurrency: 'unbounded' },
              );
            const roots = createNodeWorkspaceRoots({
              host: 'desktop',
              workspacePath: root,
              storageRoot: options.dataRoot,
              storage,
              config: {
                ...workspaceConfigs,
                global: options.globalConfigStore,
                catalog: TEXRA_SETTINGS,
              },
              workspaceState,
              repoState,
              // Every project's roots share the process's global state.
              globalState: options.processRoots.globalState,
            });
            // Acquire the session and install its registry owner before
            // interruption can leave this operation.
            return yield* Effect.uninterruptible(
              openProjectSession(
                root,
                roots,
                projectScope,
                options.service,
                sessions,
                hosts,
              ).pipe(
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
          // A failed persistence operation leaves the project with the host;
          // the session's own close, run by the project's scope, stops its
          // runs.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
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
            }).pipe(withPerKeyLane(lanes, selection)),
          );
        }).pipe(withPerKeyLane(lanes, root), Effect.mapError(ensureError));
      },
      clearRecent: () =>
        records
          .replaceRecent([])
          .pipe(Effect.andThen(syncRecent), Effect.mapError(ensureError)),
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
