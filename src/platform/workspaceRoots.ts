/**
 * Per-workspace roots: the four host services whose value depends on which
 * paper (workspace folder) a piece of code is working on. They live on the
 * owning `SessionHandle` rather than on the process-wide `platform()` object,
 * so one process can hold many sessions, each rooted in its own folder.
 *
 * Resolution: inside a roots scope ({@link runWithWorkspaceRoots}, which the
 * agent runtime enters around every run and `runInSession` body) the roots
 * come from that scope; outside any scope they fall back to the process roots
 * the composition root installed with {@link initProcessWorkspaceRoots}. The
 * extension and the CLI construct exactly one session whose roots equal the
 * process roots, so the fallback is exact there; the desktop's process roots
 * are its no-workspace roots, and every touch of a paper's storage runs inside
 * that paper's session scope.
 *
 * Transition: the fallback is a second source for one datum and goes away once
 * every `StorageFS` / `WorkspaceFS` caller runs inside a roots scope
 * (`runInSession` or `runWithWorkspaceRoots`), which the persistence
 * cutover's `Database` layer taking `session.roots.storage` at one site makes
 * checkable. No detector guards the
 * fallback in the meantime: on the extension and CLI it is exact, and on the
 * desktop a caller outside every session scope is a defect to fix at the
 * caller, not to diagnose here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ConfigProvider, StateStore } from './interfaces';

export interface WorkspaceRoots {
  /** Canonical physical workspace root, or undefined when no folder is open. */
  readonly workspace: string | undefined;
  /** Per-workspace storage root (memory, runs, transcripts). */
  readonly storage: string;
  /** Workspace-scoped configuration (project `.texra/config.json` plus global). */
  readonly config: ConfigProvider;
  /** Workspace-scoped key-value state. */
  readonly workspaceState: StateStore;
}

let processRoots: WorkspaceRoots | null = null;
const rootsScope = new AsyncLocalStorage<WorkspaceRoots>();

/**
 * Install the process roots. Called by a composition root exactly once at
 * startup, right beside `initPlatform()`.
 */
export function initProcessWorkspaceRoots(roots: WorkspaceRoots): void {
  processRoots = Object.freeze({ ...roots });
}

/** The process roots when a composition root has installed them; a
 *  process without roots has no session of its own to name. */
export function tryProcessWorkspaceRoots(): WorkspaceRoots | undefined {
  return processRoots ?? undefined;
}

function requireProcessRoots(): WorkspaceRoots {
  if (!processRoots) {
    throw new Error(
      'Workspace roots not initialized: call initProcessWorkspaceRoots() before using workspace-scoped services.',
    );
  }
  return processRoots;
}

/**
 * The process roots, read at each access rather than copied: a session built
 * without roots of its own is rooted in the process, and stays so if the
 * process roots are installed after it (test suites swap the fake platform
 * per test around one process-default session).
 */
const PROCESS_ROOTS_VIEW: WorkspaceRoots = Object.freeze({
  get workspace() {
    return requireProcessRoots().workspace;
  },
  get storage() {
    return requireProcessRoots().storage;
  },
  get config() {
    return requireProcessRoots().config;
  },
  get workspaceState() {
    return requireProcessRoots().workspaceState;
  },
});

/** The live process roots, for a session that names no folder of its own. */
export function processWorkspaceRoots(): WorkspaceRoots {
  return PROCESS_ROOTS_VIEW;
}

/**
 * Run `fn` with `roots` as the calling context's workspace roots. The agent
 * runtime enters this scope with the session's roots around every run; a host
 * enters it directly to touch a workspace's storage before that workspace has
 * a session (the desktop opens a paper's transcript store this way).
 */
export function runWithWorkspaceRoots<T>(
  roots: WorkspaceRoots,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return rootsScope.run(roots, fn);
}

/** The roots for the calling context, or undefined before any are installed. */
export function tryWorkspaceRoots(): WorkspaceRoots | undefined {
  const scopedRoots = rootsScope.getStore();
  if (scopedRoots && scopedRoots !== PROCESS_ROOTS_VIEW) return scopedRoots;
  return processRoots ?? undefined;
}

/**
 * The roots for the calling context: the enclosing scope's roots when called
 * inside one, otherwise the process roots.
 */
export function workspaceRoots(): WorkspaceRoots {
  return tryWorkspaceRoots() ?? requireProcessRoots();
}
