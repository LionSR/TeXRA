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
  Semaphore,
  SubscriptionRef,
  type Path,
} from 'effect';

import { type Session, Sessions } from '@texra-ai/harness';
import {
  withPerKeyLane,
  type PerKeyLane,
  StateStores,
} from '@texra-ai/harness/host';
import {
  absentReason,
  openNodeWorkspaceRoots,
  canonicalizeWorkspaceRoot,
} from '@texra-ai/harness/node';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { openTexraWorkspaceConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  projectDisplayOf,
  type ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import { serviceProjectState } from '@texra/controllers/server/serviceSession';
import type { ServiceLink } from '@texra/controllers/server/client';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import type { WindowClient } from '@texra/controllers/server/windowHost';
import { openProjectSession } from '@texra/controllers/session/openProjectSession';
import type { GuiSession } from '@texra/controllers/session/openGuiWindow';
import { DesktopProjectRecords } from './desktopProjectRecords.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';
import type { ConfigStore } from '@texra-ai/harness/node';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

interface DesktopProjectFacts {
  /** The session key: the storage root the session view's `SessionView.key`
   *  carries, and the project's name on every renderer message. */
  readonly key: string;
  /** Canonical folder path, or undefined for the no-workspace session. */
  readonly root: string | undefined;
  /** What the rail, the snapshot, notifications, and the window title print
   *  for it, derived once from `key` and `root`. */
  readonly display: ProjectDisplay;
  readonly roots: WorkspaceRoots;
  /** Release the session from its owner; settles once its entry has unwound. */
  dispose(): Effect.Effect<void>;
}

/** An open project: its session opened here, or the service's, which
 *  this process holds no store, run or claim of. */
export type DesktopProject = DesktopProjectFacts & {
  /** The folder; absent for the no-workspace session. */
  readonly root: string | undefined;
  readonly session: Session;
  /** What the window attaches through: this process's windows, or the
   *  service. */
  readonly link: ServiceLink<WindowClient>;
  /** Where its runs run (`GuiSession.where`). */
  readonly where: GuiSession['where'];
};

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
  /** The one store over the global config file, shared by every project's
   *  config provider. */
  readonly globalConfigStore: ConfigStore;
  /** The app's one attempt to reach the background service: a folder's
   *  runs run there when it succeeded, and here, with the banner saying
   *  why, when it failed. */
  readonly service: Result.Result<ServiceLink, Error>;
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
    const unique = [...new Set(candidates.map(canonicalizeWorkspaceRoot))];
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

/** Show `message` in a warning dialog without waiting on the user: a dialog
 *  that cannot be shown is logged, with the message it carried. */
const warnInDialog = (message: string): Effect.Effect<void> =>
  showDesktopWarningDialog(message).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `A warning dialog could not be shown (${toErrorMessage(error)}): ${message}`,
      ).pipe(withLogChannel('desktop')),
    ),
    Effect.forkDetach,
    Effect.asVoid,
  );

/**
 * Open one session over `roots`. Every fact this project's services answer
 * with comes from `roots` as data — the approval policy below — so a
 * workspace override in `.texra/config.json` is the same value a run in this
 * session would read.
 */
const openDesktopProject = Effect.fn('openDesktopProject')(function* (
  root: string | undefined,
  roots: WorkspaceRoots,
  scope: Scope.Closeable,
  service: Result.Result<ServiceLink, Error>,
): Effect.fn.Return<
  DesktopProject,
  Error,
  Scope.Scope | Sessions | HostWindows
> {
  const opened = yield* openProjectSession(roots, service, warnInDialog);
  return {
    key: roots.storage,
    display: projectDisplayOf(roots.storage, root),
    roots,
    dispose: () => Scope.close(scope, Exit.void),
    root,
    ...opened,
  };
});

/**
 * Build the registry with its no-workspace session open, so a window always
 * has a session to show even before the first folder opens.
 */
export const openDesktopProjectRegistry: (
  options: DesktopProjectRegistryOptions,
) => Effect.Effect<
  DesktopProjectRegistry,
  Error,
  DesktopProjectRecords | StateStores | Sessions | HostWindows
> = Effect.fn('openDesktopProjectRegistry')(
  function* (options: DesktopProjectRegistryOptions) {
    // The process's sessions and windows, which every project opens with.
    const sessions = yield* Sessions;
    const hosts = yield* HostWindows;
    const openProject = (...args: Parameters<typeof openDesktopProject>) =>
      openDesktopProject(...args).pipe(
        Effect.provideService(Sessions, sessions),
        Effect.provideService(HostWindows, hosts),
      );
    const records = yield* DesktopProjectRecords;
    const stateStores = yield* StateStores;
    // One open or close of a root at a time; and one write of the selection
    // and the recent list at a time, across roots.
    const lanes = new Map<string, PerKeyLane>();
    const selectionLane = yield* Semaphore.make(1);
    const fallback = yield* Effect.uninterruptible(
      openProject(
        undefined,
        options.processRoots,
        options.processScope,
        options.service,
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
    }).pipe(selectionLane.withPermit);
    const activate = Effect.fn('activate')(function* (
      root: string | undefined,
    ) {
      const next = root === undefined ? undefined : byRoot(root);
      if (next?.root !== undefined) yield* records.activate(next.root);
      const activeKey = (next ?? fallback).key;
      if (activeKey === current().activeKey) return;
      yield* SubscriptionRef.update(state, (s) => ({ ...s, activeKey }));
    }, selectionLane.withPermit);
    return {
      state,
      open(rootInput) {
        const root = canonicalizeWorkspaceRoot(rootInput);
        return Effect.gen(function* () {
          const existing = byRoot(root);
          if (existing) return existing;
          yield* records.remember(root);
          const projectScope = yield* Scope.make();
          return yield* Effect.gen(function* () {
            // The stores report while they open, through a plain callback:
            // their warnings are logged and shown once the open returns.
            const configWarnings: string[] = [];
            const workspaceConfigs = yield* openTexraWorkspaceConfigStores(
              TEXRA_SETTINGS.catalog,
              options.dataRoot,
              root,
              (message) => {
                configWarnings.push(message);
              },
            );
            for (const message of configWarnings) {
              yield* Effect.logWarning(message).pipe(withLogChannel('desktop'));
              yield* warnInDialog(message);
            }
            const roots = yield* openNodeWorkspaceRoots({
              workspaceRoot: root,
              storageRoot: options.dataRoot,
              config: {
                ...workspaceConfigs,
                global: options.globalConfigStore,
                catalog: TEXRA_SETTINGS.catalog,
              },
              // A folder of the service keeps its state there: this process
              // opens no store of that project.
              ...(Result.isSuccess(options.service) && {
                workspaceState: serviceProjectState(
                  options.service.success,
                  root,
                ),
              }),
              stateStores,
              // Every project's roots share the process's global state.
              globalState: options.processRoots.globalState,
            });
            // Acquire the session and install its registry owner before
            // interruption can leave this operation.
            return yield* Effect.uninterruptible(
              openProject(root, roots, projectScope, options.service).pipe(
                Effect.tap(
                  Effect.fnUntraced(function* (project) {
                    const recent = yield* records.readRecent;
                    yield* SubscriptionRef.update(state, (s) => ({
                      ...s,
                      projects: [...s.projects, project],
                      recent,
                    }));
                  }, selectionLane.withPermit),
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
            }).pipe(selectionLane.withPermit),
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
  },
  Effect.uninterruptible,
  Effect.mapError(ensureError),
);
