/**
 * Per-workspace roots: the four host services whose value depends on which
 * paper (workspace folder) a piece of code is working on. They live on the
 * owning `SessionHandle` rather than on the process-wide `platform()` object,
 * so one process can hold many sessions, each rooted in its own folder.
 *
 * Resolution is by hand, not by ambient scope: a caller answers for the
 * workspace whose roots it was given — a tool call's `call.roots`, a run's
 * `session.roots`, a host command's `session.roots`. The `AsyncLocalStorage`
 * frame this module used to carry is gone (#12421), because an Effect fiber
 * resumes outside every such frame and so could never be trusted to hold one.
 *
 * What remains is the process roots: the one record a composition root
 * installs at startup, for the two callers that precede every session — the
 * session owner naming its default session, and the pre-initialization logger
 * read.
 */
import type { ConfigProvider, StateStore } from './interfaces';

export interface WorkspaceRoots {
  /** Canonical physical workspace root, or undefined when no folder is open. */
  readonly workspace: string | undefined;
  /** Application-owned storage for this project's TeXRA 1.0 state. Custom
   * hosts must keep this separate from earlier release storage directories;
   * session services use this exact root without importing previous state. */
  readonly storage: string;
  /**
   * Cross-workspace global storage root. Process-wide by construction — every
   * host derives it from the one storage root it opened — and carried here
   * rather than on `platform()` so the storage paths have a single carrier.
   */
  readonly globalStorage: string;
  /** Workspace-scoped configuration (project `.texra/config.json` plus global). */
  readonly config: ConfigProvider;
  /** Workspace-scoped key-value state. */
  readonly workspaceState: StateStore;
  /**
   * Process-wide application state: the third of the three slots the settings
   * catalog resolves a row against (`config`, `workspaceState`, `globalState`).
   * Process-wide by construction like {@link globalStorage}, and carried here
   * rather than on `platform()` so a caller that has resolved its roots holds
   * every slot. Inside Effect the owner is the `AppState` service.
   */
  readonly globalState: StateStore;
}

let processRoots: WorkspaceRoots | null = null;

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

/** The current process roots for unscoped callers. Session opening snapshots
 * this view so its owner key and storage root stay stable for its lifetime. */
const PROCESS_ROOTS_VIEW: WorkspaceRoots = Object.freeze({
  get workspace() {
    return requireProcessRoots().workspace;
  },
  get storage() {
    return requireProcessRoots().storage;
  },
  get globalStorage() {
    return requireProcessRoots().globalStorage;
  },
  get config() {
    return requireProcessRoots().config;
  },
  get workspaceState() {
    return requireProcessRoots().workspaceState;
  },
  get globalState() {
    return requireProcessRoots().globalState;
  },
});

/** The live process roots for callers that need the current process root. */
export function processWorkspaceRoots(): WorkspaceRoots {
  return PROCESS_ROOTS_VIEW;
}
