/**
 * Per-workspace roots: the four host services whose value depends on which
 * paper (workspace folder) a piece of code is working on. They live on the
 * owning `SessionHandle` rather than on the process-wide `platform()` object,
 * so one process can hold many sessions, each rooted in its own folder.
 *
 * Resolution: inside a run (or a `runInSession` scope) the roots come from the
 * ambient run context; outside any run they fall back to the process roots the
 * composition root installed with {@link initProcessWorkspaceRoots}. The
 * extension and the CLI construct exactly one session whose roots equal the
 * process roots, so the fallback is exact there; the desktop's process roots
 * are its no-workspace roots, and every touch of a paper's storage runs inside
 * that paper's session scope.
 */
import { getRunContextRoots } from '@agent/runtime/RunContext';

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

/**
 * Install the process roots. Called by a composition root exactly once at
 * startup, right beside `initPlatform()`.
 */
export function initProcessWorkspaceRoots(roots: WorkspaceRoots): void {
  processRoots = Object.freeze({ ...roots });
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

/** The roots for the calling context, or undefined before any are installed. */
export function tryWorkspaceRoots(): WorkspaceRoots | undefined {
  const contextRoots = getRunContextRoots();
  if (contextRoots && contextRoots !== PROCESS_ROOTS_VIEW) return contextRoots;
  return processRoots ?? undefined;
}

/**
 * The roots for the calling context: the active run's session roots when
 * called inside a run, otherwise the process roots.
 */
export function workspaceRoots(): WorkspaceRoots {
  return tryWorkspaceRoots() ?? requireProcessRoots();
}
