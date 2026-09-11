// The desktop's open projects: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which project it shows.

import { stat } from 'node:fs/promises';

import { Effect } from 'effect';

import {
  agentResponseTextConnector,
  openSessionEffect,
  runInSession,
  type SessionHandle,
} from '@agent/runtime';
import { hostPort } from '@common/hostPort';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { DisposableStore } from '@platform/disposable';
import { effectRuntime } from '@platform/processRuntime';
import {
  runWithWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import {
  openNodeWorkspaceStateStore,
  openTexraWorkspaceConfigStore,
} from '@platform/defaults/nodeStores';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { StreamLogStore } from '@transcript';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { readPlatformSetting } from '@utils/config/platformSettings';
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
  dispose(): void;
}

interface DesktopProjectRegistryOptions {
  /** Desktop data root (`~/.texra` in production, the e2e profile otherwise). */
  readonly dataRoot: string;
  /** Roots of the no-workspace session; the process roots. */
  readonly processRoots: WorkspaceRoots;
  /**
   * The one store over the global config file, shared by every project's
   * config provider: a `JsonStore` serves reads from its own open-time view,
   * so a second instance over the same file would not see a global setting
   * another project changed until the next launch.
   */
  readonly globalConfigStore: ConfigStore;
  readonly records: DesktopProjectRecords;
  warn(message: string): void;
}

export interface DesktopProjectRegistry {
  /** Open a folder as a project, remember it for the next launch, or return the one already open. */
  open(root: string): Effect.Effect<DesktopProject, Error>;
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
  flushArtifacts(): Promise<void>;
  /** Dispose every session, the most recently opened first. */
  dispose(): void;
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
            if (isFileNotFoundError(error) || isNotADirectoryError(error))
              return undefined;
            warn(
              `Cannot read the remembered project ${root}; forgetting it: ${toErrorMessage(error)}`,
            );
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

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

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
async function stopProjectRuns(session: SessionHandle): Promise<void> {
  const { runs } = session;
  await runInSession(session, async () => {
    const stops = runs.getActiveIds().flatMap((runId) => {
      if (runs.getHandle(runId)?.isChild) return [];
      return [runs.kill(runId, { detachActiveChildren: false }).settlement];
    });
    await effectRuntime().runPromise(
      Effect.all(stops, { concurrency: 'unbounded' }),
    );
    for (;;) {
      const active = runs.getActiveIds();
      if (active.length === 0) return;
      await effectRuntime().runPromise(runs.waitForAnyChange(active));
    }
  });
}

/**
 * Open one session over `roots`. The transcript store is opened in the
 * workspace scope (it reads `StorageFS` before the session exists); everything
 * after that runs in the session's own scope.
 */
function openProjectSession(
  root: string | undefined,
  roots: WorkspaceRoots,
): Effect.Effect<DesktopProject, Error> {
  return Effect.gen(function* () {
    const session = yield* openSessionEffect({ roots, responseTextProcessing });
    return yield* Effect.try({
      try: () =>
        runInSession(session, () => {
          session.setApprovalPolicy(
            readPlatformSetting<TexraApprovalPolicy>(
              TEXRA_APPROVAL_POLICY_CONFIG_KEY,
            ),
          );
          return {
            key: roots.storage,
            root,
            roots,
            session,
            dispose: () => runInSession(session, () => session.dispose()),
          };
        }),
      catch: ensureError,
    }).pipe(Effect.onError(() => Effect.sync(() => session.dispose())));
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
      openProjectSession(undefined, options.processRoots),
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
          const storage = new WorkspaceStorageProvider(
            options.dataRoot,
            root,
          ).getStoragePath();
          const [workspaceState, workspaceConfig] = yield* Effect.all(
            [
              openNodeWorkspaceStateStore(storage),
              openTexraWorkspaceConfigStore(storage, root, options.warn),
            ],
            { concurrency: 'unbounded' },
          );
          const roots = createNodeWorkspaceRoots({
            workspacePath: root,
            storage,
            config: {
              workspace: workspaceConfig,
              global: options.globalConfigStore,
            },
            workspaceState,
          });
          // Acquire the session and install its registry owner before
          // interruption can leave this operation.
          return yield* Effect.uninterruptible(
            openProjectSession(root, roots).pipe(
              Effect.tap((project) =>
                Effect.sync(() => {
                  projects.set(root, project);
                  notify();
                }).pipe(withPerKeyLane(lanes, selection)),
              ),
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
              yield* hostPort(() => stopProjectRuns(project.session));
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
                project.dispose();
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
      async flushArtifacts() {
        const failures: string[] = [];
        for (const project of [fallback, ...projects.values()]) {
          await effectRuntime().runPromise(
            hostPort(() =>
              runInSession(project.session, () =>
                project.session.flushArtifacts(),
              ),
            ).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  failures.push(
                    `${project.root ?? 'no workspace'}: ${toErrorMessage(error)}`,
                  );
                }),
              ),
            ),
          );
        }
        if (failures.length > 0)
          throw new Error(
            `Failed to flush desktop session artifacts: ${failures.join('; ')}`,
          );
      },
      dispose() {
        const store = new DisposableStore();
        store.add(() => fallback.dispose());
        for (const project of projects.values())
          store.add(() => project.dispose());
        projects.clear();
        store.dispose();
      },
    } satisfies DesktopProjectRegistry;
  }).pipe(Effect.uninterruptible, Effect.mapError(ensureError));
}
