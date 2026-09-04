// The desktop's open papers: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which paper it shows.

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import type { SessionStores } from '@agent/storage';
import {
  agentResponseTextConnector,
  attachTerminalResultToast,
  runInSession,
  runInWorkspace,
  SessionHandle,
} from '@agent/runtime';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { DisposableStore } from '@platform/disposable';
import type { ConfigProvider, StateStore } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import {
  openNodeWorkspaceStateStore,
  openTexraConfigStores,
} from '@platform/defaults/nodeStores';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { COMMON_COMMANDS } from '@shared/ipc';
import { StreamLogStore } from '@transcript';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  DESKTOP_PAPER_COMMANDS,
  DesktopClosePaperMessageSchema,
  DesktopSelectPaperMessageSchema,
  type DesktopPapersMessage,
} from '../shared/desktopPaperMessages.js';
import { initializeDesktopProcessStores } from './desktopProcessStores.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopPaper {
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
/** The single-workspace key the relaunch flow stored; folded in once, then deleted. */
const LEGACY_WORKSPACE_PATH_STATE_KEY = 'texra.desktop.workspacePath';

interface DesktopPaperRegistryOptions {
  /** Desktop data root (`~/.texra` in production, the e2e profile otherwise). */
  readonly dataRoot: string;
  /** Roots of the no-workspace session; the process roots. */
  readonly processRoots: WorkspaceRoots;
  readonly globalState: StateStore;
  /**
   * Process-lifetime attachment each session needs (stream resumption).
   * Returns the detach, which closing the paper runs before its session goes.
   */
  attachSession(session: SessionHandle): () => void;
  warn(message: string): void;
}

export interface DesktopPaperRegistry {
  /** Open a folder as a paper, remember it for the next launch, or return the one already open. */
  open(root: string): Promise<DesktopPaper>;
  /** Open papers in the order they were opened; the no-workspace session is not one. */
  list(): readonly DesktopPaper[];
  /** The paper the window shows: the active folder, else the no-workspace session. */
  active(): DesktopPaper;
  /** Make an open paper the one the window shows, and remember it as such. */
  activate(root: string | undefined): void;
  /**
   * Close an open paper: forget it for the next launch, dispose its session in
   * its own scope, and show the most recently shown remaining paper if it was
   * the active one. The other papers' runs are untouched.
   */
  close(root: string): Promise<void>;
  /** Workspace state of whichever paper is active at call time. */
  readonly activeWorkspaceState: StateStore;
  /** Config of whichever paper is active at call time. */
  readonly activeConfig: ConfigProvider;
  summary(): Omit<DesktopPapersMessage, 'command'>;
  /** Fires after a paper opens or the active paper changes. */
  onChange(listener: () => void): () => void;
  /**
   * Renderer traffic about papers: `SELECT_PAPER` requests, and the main
   * view's ready signal, after which the renderer needs the papers list.
   */
  ipc(handlers: {
    select(root: string): void;
    close(root: string): void;
    postPapers(): void;
  }): DesktopMessageHandler;
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
 * canonical root, with the pre-papers single workspace key folded in once and
 * then deleted, and with folders that no longer exist dropped. The list is
 * written back whenever any of that changed it.
 */
export async function readRememberedDesktopPapers(
  globalState: StateStore,
  warn: (message: string) => void,
): Promise<RememberedDesktopPapers> {
  const stored = readRememberedPapers(globalState, warn);
  const legacy = globalState.get<string>(LEGACY_WORKSPACE_PATH_STATE_KEY);
  const candidates = [...stored];
  if (typeof legacy === 'string' && legacy.trim()) {
    // The relaunch flow stored the raw dialog path; the list is canonical.
    candidates.push(legacy.trim());
  }
  const roots: string[] = [];
  const missing: string[] = [];
  for (const candidate of candidates) {
    const root = canonicalizeWorkspacePath(candidate);
    if (roots.includes(root) || missing.includes(root)) continue;
    (existsSync(root) ? roots : missing).push(root);
  }
  const changed =
    legacy !== undefined ||
    roots.length !== stored.length ||
    roots.some((root, index) => root !== stored[index]);
  if (changed) {
    await writeRememberedPapers(globalState, roots);
  }
  if (legacy !== undefined) {
    await globalState.update(LEGACY_WORKSPACE_PATH_STATE_KEY, undefined);
  }
  return { roots, missing };
}

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

/**
 * Open one session over `roots`. The transcript store is opened in the
 * workspace scope (it reads `StorageFS` before the session exists); everything
 * after that runs in the session's own scope.
 */
async function openPaperSession(
  root: string | undefined,
  roots: WorkspaceRoots,
  options: Pick<DesktopPaperRegistryOptions, 'attachSession'>,
): Promise<DesktopPaper> {
  const resources = new DisposableStore();
  try {
    // A broken transcript directory must not reject startup: degrade to an
    // in-memory store and warn once the window exists, exactly as the CLI
    // TUI does. The degraded session also cannot resume: nothing is
    // persisted for a later launch to pick up, and `SessionHandle` skips
    // restart repair on a non-persistent store.
    const transcripts = await runInWorkspace(roots, () =>
      StreamLogStore.openOrEphemeral(),
    );
    const session = new SessionHandle({
      transcripts,
      roots,
      restartRepair: 'deferred',
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
      await session.waitUntilReady();
      session.setApprovalPolicy(
        readPlatformSetting<TexraApprovalPolicy>(
          TEXRA_APPROVAL_POLICY_CONFIG_KEY,
        ),
      );
      resources.add(options.attachSession(session));
      return {
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
  const papers = new Map<string, DesktopPaper>();
  const opening = new Map<string, Promise<DesktopPaper>>();
  const listeners = new Set<() => void>();
  let activeRoot: string | undefined;
  const fallback = await openPaperSession(
    undefined,
    options.processRoots,
    options,
  );

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const active = (): DesktopPaper =>
    (activeRoot === undefined ? undefined : papers.get(activeRoot)) ?? fallback;
  const activeRoots = () => active().roots;

  async function openPaper(root: string): Promise<DesktopPaper> {
    const storage = new WorkspaceStorageProvider(options.dataRoot, root);
    const [workspaceState, configStores] = await Promise.all([
      openNodeWorkspaceStateStore(storage),
      openTexraConfigStores(storage, root, options.warn),
    ]);
    const roots = createNodeWorkspaceRoots({
      workspacePath: root,
      storage,
      config: configStores,
      workspaceState,
    });
    const paper = await openPaperSession(root, roots, options);
    papers.set(root, paper);
    const remembered = readRememberedPapers(options.globalState, options.warn);
    if (!remembered.includes(root)) {
      await writeRememberedPapers(options.globalState, [...remembered, root]);
    }
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
        pending = openPaper(root).finally(() => opening.delete(root));
        opening.set(root, pending);
      }
      return pending;
    },
    list: () => [...papers.values()],
    active,
    activate,
    async close(root) {
      const paper = papers.get(root);
      if (!paper) return;
      papers.delete(root);
      // The window moves off the paper before its session goes: the paper the
      // user showed most recently before this one, else the no-workspace
      // session. `activate` notifies, and listeners release their bindings to
      // the closed paper inside its still-live session scope.
      if (activeRoot === root) {
        activate(
          readRememberedPapers(options.globalState, options.warn).findLast(
            (entry) => entry !== root && papers.has(entry),
          ) ?? [...papers.keys()].at(-1),
        );
      } else {
        notify();
      }
      try {
        paper.dispose();
      } finally {
        await writeRememberedPapers(
          options.globalState,
          readRememberedPapers(options.globalState, options.warn).filter(
            (entry) => entry !== root,
          ),
        );
      }
    },
    activeWorkspaceState: {
      get: <T>(key: string, defaultValue?: T) =>
        activeRoots().workspaceState.get<T>(key, defaultValue),
      update: (key, value) => activeRoots().workspaceState.update(key, value),
    },
    activeConfig: {
      get: <T>(key: string, defaultValue?: T) =>
        activeRoots().config.get<T>(key, defaultValue),
      update: (key, value, target) =>
        activeRoots().config.update(key, value, target),
      inspect: (key) => activeRoots().config.inspect(key),
      isExplicitlySet: (key) => activeRoots().config.isExplicitlySet(key),
    },
    summary: () => ({
      papers: [...papers.keys()].map((root) => ({
        root,
        name: basename(root) || root,
      })),
      activeRoot: activeRoot ?? null,
    }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ipc: (handlers) => ({
      handleMessage(message: DesktopCommandMessage): boolean {
        if (message.command === COMMON_COMMANDS.WEBVIEW_READY) {
          // A pass-through like the progress ready signal: the main view's
          // ready message still reaches the startup handler.
          if ((message as { view?: unknown }).view === 'main') {
            handlers.postPapers();
          }
          return false;
        }
        if (message.command === DESKTOP_PAPER_COMMANDS.CLOSE_PAPER) {
          const parsed = DesktopClosePaperMessageSchema.safeParse(message);
          if (!parsed.success) return false;
          handlers.close(parsed.data.root);
          return true;
        }
        if (message.command !== DESKTOP_PAPER_COMMANDS.SELECT_PAPER) {
          return false;
        }
        const parsed = DesktopSelectPaperMessageSchema.safeParse(message);
        if (!parsed.success) return false;
        handlers.select(parsed.data.root);
        return true;
      },
    }),
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
