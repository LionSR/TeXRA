// The desktop's open papers: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which paper it shows.

import { statSync } from 'node:fs';

import type { SessionStores } from '@agent/storage';
import {
  agentResponseTextConnector,
  attachTerminalResultToast,
  runInSession,
  SessionHandle,
} from '@agent/runtime';
import { scheduleLeftoverStreamSweep } from '@controllers/session/scheduleLeftoverStreamSweep';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { DisposableStore } from '@platform/disposable';
import type { StateStore } from '@platform/interfaces';
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
import { readPlatformSetting } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { DesktopPapersMessage } from '../shared/desktopPaperMessages.js';
import { initializeDesktopProcessStores } from './desktopProcessStores.js';

export interface DesktopPaper {
  /** The session key: the storage root the fold's `SessionView.key`
   *  carries, and the paper's name on every renderer message. */
  readonly key: string;
  /** Canonical folder path, or undefined for the no-workspace session. */
  readonly root: string | undefined;
  readonly roots: WorkspaceRoots;
  readonly session: SessionHandle;
  readonly stores: SessionStores;
  dispose(): void;
}

/**
 * Folders reopened at the next launch, the one the window last showed at the
 * end: opening appends, activating moves to the end, closing removes.
 */
const DESKTOP_OPEN_PAPERS_STATE_KEY = 'texra.desktop.openPapers';

interface DesktopPaperRegistryOptions {
  /** Desktop data root (`~/.texra` in production, the e2e profile otherwise). */
  readonly dataRoot: string;
  /** Roots of the no-workspace session; the process roots. */
  readonly processRoots: WorkspaceRoots;
  /**
   * The one store over the global config file, shared by every paper's
   * config provider: a `JsonStore` serves reads from its own open-time view,
   * so a second instance over the same file would not see a global setting
   * another paper changed until the next launch.
   */
  readonly globalConfigStore: ConfigStore;
  readonly globalState: StateStore;
  warn(message: string): void;
}

export interface DesktopPaperRegistry {
  /** Open a folder as a paper, remember it for the next launch, or return the one already open. */
  open(root: string): Promise<DesktopPaper>;
  /** Open papers in the order they were opened; the no-workspace session is not one. */
  list(): readonly DesktopPaper[];
  /** The paper the window shows: the active folder, else the no-workspace session. */
  active(): DesktopPaper;
  /** The no-workspace session's paper; open for the process lifetime, never in `list()`. */
  fallback(): DesktopPaper;
  /** Make an open paper the one the window shows, and remember it as such. */
  activate(root: string | undefined): void;
  /**
   * Close an open paper: forget it for the next launch, stop its runs and
   * wait for them to settle, dispose its session in its own scope, and show
   * the most recently shown remaining paper if it was the active one. The
   * other papers' runs are untouched.
   */
  close(root: string): Promise<void>;
  summary(): Omit<DesktopPapersMessage, 'command'>;
  /** Fires after a paper opens or closes, or the active paper changes. */
  onChange(listener: () => void): () => void;
  flushArtifacts(): Promise<void>;
  /** Dispose every session, the most recently opened first. */
  dispose(): void;
}

function readRememberedPapers(
  globalState: StateStore,
  warn: (message: string) => void,
): string[] {
  const raw = globalState.get<unknown>(DESKTOP_OPEN_PAPERS_STATE_KEY);
  if (raw === undefined) return [];
  const entries = Array.isArray(raw) ? raw : [];
  const roots = entries.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  if (!Array.isArray(raw) || roots.length !== entries.length) {
    // The next write persists the filtered list, so say what was dropped.
    warn(
      `Ignoring malformed entries in ${DESKTOP_OPEN_PAPERS_STATE_KEY}: expected a list of folder paths, got ${JSON.stringify(raw)}`,
    );
  }
  return roots;
}

async function writeRememberedPapers(
  globalState: StateStore,
  roots: readonly string[],
): Promise<void> {
  await globalState.update(DESKTOP_OPEN_PAPERS_STATE_KEY, [...roots]);
}

export interface RememberedDesktopPapers {
  /** Canonical roots to reopen, the one to show last. */
  readonly roots: readonly string[];
  /** Remembered roots whose folder no longer exists; forgotten. */
  readonly missing: readonly string[];
}

/**
 * The folders to reopen at launch: the remembered list, deduplicated by
 * canonical root, with entries that are no longer a folder dropped (a
 * remembered path that a regular file has since replaced is not a paper
 * either, nor is one that cannot be read at all: permissions, a dead mount).
 * The list is written back whenever that changed it.
 */
export async function readRememberedDesktopPapers(
  globalState: StateStore,
  warn: (message: string) => void,
): Promise<RememberedDesktopPapers> {
  const stored = readRememberedPapers(globalState, warn);
  const roots: string[] = [];
  const missing: string[] = [];
  for (const candidate of stored) {
    const root = canonicalizeWorkspacePath(candidate);
    if (roots.includes(root) || missing.includes(root)) continue;
    let isFolder = false;
    try {
      isFolder =
        statSync(root, { throwIfNoEntry: false })?.isDirectory() ?? false;
    } catch (error) {
      // Persisted state validated at its boundary: an unreadable path is
      // reported and forgotten like a missing one, so it cannot fail every
      // launch until repaired by hand.
      warn(
        `Cannot read the remembered paper ${root}; forgetting it: ${toErrorMessage(error)}`,
      );
    }
    (isFolder ? roots : missing).push(root);
  }
  const changed =
    roots.length !== stored.length ||
    roots.some((root, index) => root !== stored[index]);
  if (changed) {
    await writeRememberedPapers(globalState, roots);
  }
  return { roots, missing };
}

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

/**
 * Stop every run the paper still owns and wait for their drivers to settle
 * them (CANCELLED, flow record preserved for a later resume), so the session
 * is disposed with nothing executing under it: `ExecutionRegistry.dispose`
 * clears its handles without interrupting them, and a run left driving after
 * that would continue with no presentation and no stop control. Only roots
 * are killed; the stop cascades into their children. Unbounded on purpose: a
 * tool that ignores its kill is the same problem the process exit drain has,
 * and the paper stays open, stoppable and visible in the log, until it ends.
 */
async function stopPaperExecutions(session: SessionHandle): Promise<void> {
  const { executions } = session;
  await runInSession(session, async () => {
    for (const executionId of executions.getActiveIds()) {
      if (executions.getHandle(executionId)?.isChildExecution) continue;
      executions.kill(executionId, { detachActiveChildren: false });
    }
    for (;;) {
      const active = executions.getActiveIds();
      if (active.length === 0) return;
      await executions.waitForAnyChange(active);
    }
  });
}

/**
 * Open one session over `roots`. The transcript store is opened in the
 * workspace scope (it reads `StorageFS` before the session exists); everything
 * after that runs in the session's own scope.
 */
async function openPaperSession(
  root: string | undefined,
  roots: WorkspaceRoots,
): Promise<DesktopPaper> {
  const resources = new DisposableStore();
  try {
    // A broken transcript directory must not reject startup: degrade to an
    // in-memory store and warn once the window exists, exactly as the CLI
    // TUI does. The degraded session also cannot resume: nothing is
    // persisted for a later launch to pick up.
    const transcripts = await runWithWorkspaceRoots(roots, () =>
      StreamLogStore.openOrEphemeral(),
    );
    const session = new SessionHandle({
      transcripts,
      roots,
      responseTextProcessing,
    });
    resources.add(() => session.dispose());
    resources.add(
      attachTerminalResultToast(session, session.interactions, {
        replayWhenAttached: true,
      }),
    );
    return await runInSession(session, async () => {
      const processStores = await initializeDesktopProcessStores(session);
      resources.add(() => processStores.dispose());
      session.setApprovalPolicy(
        readPlatformSetting<TexraApprovalPolicy>(
          TEXRA_APPROVAL_POLICY_CONFIG_KEY,
        ),
      );
      // Off the open path: the leftover-stream sweep reads this paper's
      // whole storage root, so it starts on a timer nothing awaits. It is
      // scheduled inside the session scope, which the timer inherits, so the
      // sweep reads this paper's storage and not another's; closing the paper
      // or shutting the process down cancels it if it has not started.
      resources.add(scheduleLeftoverStreamSweep(session));
      return {
        key: roots.storage,
        root,
        roots,
        session,
        stores: processStores.stores,
        dispose: () => runInSession(session, () => resources.dispose()),
      };
    });
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

/**
 * Build the registry with its no-workspace session open, so a window always
 * has a session to show even before the first folder opens.
 */
export async function openDesktopPaperRegistry(
  options: DesktopPaperRegistryOptions,
): Promise<DesktopPaperRegistry> {
  /** The open papers by canonical root; a closing paper has already left. */
  const papers = new Map<string, DesktopPaper>();
  const opening = new Map<string, Promise<DesktopPaper>>();
  /**
   * Closes in progress by root, until the close has disposed the session, so
   * a concurrent `open` of the same folder waits for it instead of building
   * a second session over the same storage.
   */
  const closing = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let activeRoot: string | undefined;
  const fallback = await openPaperSession(undefined, options.processRoots);

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const openPapers = () => [...papers.values()];
  const active = (): DesktopPaper =>
    (activeRoot === undefined ? undefined : papers.get(activeRoot)) ?? fallback;

  async function openPaper(root: string): Promise<DesktopPaper> {
    // Remembered before anything is built: a list that cannot be written is
    // the cheap failure, and it leaves no live session behind to undo.
    const remembered = readRememberedPapers(options.globalState, options.warn);
    if (!remembered.includes(root)) {
      await writeRememberedPapers(options.globalState, [...remembered, root]);
    }
    const storage = new WorkspaceStorageProvider(
      options.dataRoot,
      root,
    ).getStoragePath();
    const [workspaceState, workspaceConfig] = await Promise.all([
      openNodeWorkspaceStateStore(storage),
      openTexraWorkspaceConfigStore(storage, root, options.warn),
    ]);
    const roots = createNodeWorkspaceRoots({
      workspacePath: root,
      storage,
      config: { workspace: workspaceConfig, global: options.globalConfigStore },
      workspaceState,
    });
    const paper = await openPaperSession(root, roots);
    papers.set(root, paper);
    notify();
    return paper;
  }

  /** Persist which paper the window shows: last in the remembered list. */
  const rememberActive = (root: string) => {
    const remembered = readRememberedPapers(options.globalState, options.warn);
    if (remembered.at(-1) === root) return;
    void writeRememberedPapers(options.globalState, [
      ...remembered.filter((entry) => entry !== root),
      root,
    ]).catch((error: unknown) => {
      options.warn(
        `Could not remember the active paper ${root}: ${toErrorMessage(error)}`,
      );
    });
  };

  const activate = (root: string | undefined) => {
    const next = root !== undefined && papers.has(root) ? root : undefined;
    if (next !== undefined) rememberActive(next);
    if (next === activeRoot) return;
    activeRoot = next;
    notify();
  };

  return {
    open(rootInput) {
      const root = canonicalizeWorkspacePath(rootInput);
      const existing = papers.get(root);
      if (existing) return Promise.resolve(existing);
      let pending = opening.get(root);
      if (!pending) {
        // A folder still closing reopens once its old session is gone, so
        // the two never share transcript and storage paths.
        const closed = closing.get(root);
        pending = (
          closed ? closed.then(() => openPaper(root)) : openPaper(root)
        ).finally(() => opening.delete(root));
        opening.set(root, pending);
      }
      return pending;
    },
    list: openPapers,
    active,
    fallback: () => fallback,
    activate,
    close(root) {
      const inProgress = closing.get(root);
      if (inProgress) return inProgress;
      const paper = papers.get(root);
      if (!paper) return Promise.resolve();
      // The paper leaves the registry before anything else: `list` and
      // `active` no longer show it, so the successor chosen below is another
      // paper (or the no-workspace session), never this one. The window moves
      // off the paper before its session goes: `activate` notifies, and
      // listeners release their bindings to the closed paper inside its
      // still-live session scope.
      papers.delete(root);
      if (activeRoot === root) {
        activate(
          readRememberedPapers(options.globalState, options.warn).findLast(
            (candidate) => papers.has(candidate),
          ) ?? openPapers().at(-1)?.root,
        );
      } else {
        notify();
      }
      const closed = (async () => {
        try {
          await stopPaperExecutions(paper.session);
          paper.dispose();
        } finally {
          await writeRememberedPapers(
            options.globalState,
            readRememberedPapers(options.globalState, options.warn).filter(
              (candidate) => candidate !== root,
            ),
          );
        }
      })().finally(() => closing.delete(root));
      closing.set(root, closed);
      return closed;
    },
    summary: () => ({
      papers: openPapers().flatMap((paper) =>
        paper.root === undefined ? [] : [{ key: paper.key, root: paper.root }],
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
      for (const paper of [fallback, ...papers.values()]) {
        try {
          await runInSession(paper.session, () =>
            paper.session.flushArtifacts(),
          );
        } catch (error) {
          failures.push(
            `${paper.root ?? 'no workspace'}: ${toErrorMessage(error)}`,
          );
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `Failed to flush desktop session artifacts: ${failures.join('; ')}`,
        );
      }
    },
    dispose() {
      const store = new DisposableStore();
      store.add(() => fallback.dispose());
      for (const paper of papers.values()) store.add(() => paper.dispose());
      papers.clear();
      store.dispose();
    },
  };
}
