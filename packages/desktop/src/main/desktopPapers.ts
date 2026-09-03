// The desktop's open papers: one `SessionHandle` per open folder, each rooted
// in that folder's `WorkspaceRoots`, plus the no-workspace session the window
// shows before any folder is open. Opening a second folder no longer relaunches
// the process; the window switches which paper it shows.

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

/** Folders reopened at the next launch, most recently opened last. */
const DESKTOP_OPEN_PAPERS_STATE_KEY = 'texra.desktop.openPapers';
/** The single-workspace key the relaunch flow stored; folded in once, then deleted. */
const LEGACY_WORKSPACE_PATH_STATE_KEY = 'texra.desktop.workspacePath';

interface DesktopPaperRegistryOptions {
  /** Desktop data root (`~/.texra` in production, the e2e profile otherwise). */
  readonly dataRoot: string;
  /** Roots of the no-workspace session; the process roots. */
  readonly processRoots: WorkspaceRoots;
  readonly globalState: StateStore;
  /** Process-lifetime attachment each session needs (stream resumption). */
  attachSession(session: SessionHandle): void;
  warn(message: string): void;
}

export interface DesktopPaperRegistry {
  /** Open a folder as a paper, remember it for the next launch, or return the one already open. */
  open(root: string): Promise<DesktopPaper>;
  /** Open papers in the order they were opened; the no-workspace session is not one. */
  list(): readonly DesktopPaper[];
  /** The paper the window shows: the active folder, else the no-workspace session. */
  active(): DesktopPaper;
  /** Make an open paper the one the window shows. */
  activate(root: string | undefined): void;
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
    postPapers(): void;
  }): DesktopMessageHandler;
  flushArtifacts(): Promise<void>;
  /** Dispose every session, the most recently opened first. */
  dispose(): void;
}

function readRememberedPapers(globalState: StateStore): string[] {
  const raw = globalState.get<unknown>(DESKTOP_OPEN_PAPERS_STATE_KEY);
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * The folders to reopen at launch: the remembered list, with the pre-papers
 * single workspace key folded in once and then deleted.
 */
export async function readRememberedDesktopPapers(
  globalState: StateStore,
): Promise<string[]> {
  const remembered = readRememberedPapers(globalState);
  const legacy = globalState.get<string>(LEGACY_WORKSPACE_PATH_STATE_KEY);
  if (typeof legacy === 'string' && legacy.trim()) {
    remembered.push(legacy.trim());
    await globalState.update(DESKTOP_OPEN_PAPERS_STATE_KEY, remembered);
    await globalState.update(LEGACY_WORKSPACE_PATH_STATE_KEY, undefined);
  }
  return remembered;
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
    // TUI does. The degraded session also cannot resume — nothing is
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
      options.attachSession(session);
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
    const remembered = readRememberedPapers(options.globalState);
    if (!remembered.includes(root)) {
      await options.globalState.update(DESKTOP_OPEN_PAPERS_STATE_KEY, [
        ...remembered,
        root,
      ]);
    }
    notify();
    return paper;
  }

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
    activate(root) {
      const next = root !== undefined && papers.has(root) ? root : undefined;
      if (next === activeRoot) return;
      activeRoot = next;
      notify();
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
