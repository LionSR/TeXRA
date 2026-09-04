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
 *
 * Transition: the fallback is a second source for one datum and goes away once
 * every `StorageFS` / `WorkspaceFS` caller runs inside a session (`runInSession`
 * or `runInWorkspace`), which the persistence cutover's `Database` layer taking
 * `session.roots.storage` at one site makes checkable. Until then a fallback
 * hit that is ambiguous, one taken while a session rooted elsewhere is live,
 * is logged at warn with its caller (once per caller).
 */
import { getRunContextRoots } from '@agent/runtime/RunContext';
import { createLog } from '@logger/logUtils';

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

/** Roots of every live session, so a process-root fallback knows when it is ambiguous. */
const liveSessionRoots: WorkspaceRoots[] = [];

/**
 * Record a live session's roots; returns the release the session runs at
 * teardown. Called by the `SessionHandle` constructor, nowhere else.
 */
export function registerSessionRoots(roots: WorkspaceRoots): () => void {
  liveSessionRoots.push(roots);
  return () => {
    const index = liveSessionRoots.lastIndexOf(roots);
    if (index !== -1) liveSessionRoots.splice(index, 1);
  };
}

/** Whether a session rooted somewhere other than the process roots is live. */
function hasForeignSessionRoots(): boolean {
  return liveSessionRoots.some(
    (roots) => roots !== PROCESS_ROOTS_VIEW && roots !== processRoots,
  );
}

/** Frames that belong to the resolution itself, not to the caller. */
const RESOLUTION_FRAME_FILES = [
  'workspaceRoots.ts',
  'storageFS.ts',
  'workspaceFS.ts',
  'nodeHost.ts',
];
const warnedFallbackCallers = new Set<string>();
let fallbackLog: ReturnType<typeof createLog> | undefined;

/**
 * Report a fallback to the process roots taken while another session is live:
 * the caller is outside every session scope, so the desktop cannot know which
 * paper it meant. Once per caller; the logger is created on first use because
 * the log module reaches this one through the config readers.
 */
function warnAmbiguousFallback(): void {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const caller =
    frames.find(
      (frame) => !RESOLUTION_FRAME_FILES.some((file) => frame.includes(file)),
    ) ?? frames[0];
  const site = caller?.trim() ?? 'unknown caller';
  if (warnedFallbackCallers.has(site)) return;
  warnedFallbackCallers.add(site);
  fallbackLog ??= createLog('workspaceRoots');
  fallbackLog.warn(
    `workspaceRoots() fell back to the process roots outside any session while a session rooted elsewhere is live; run this caller inside runInSession or runInWorkspace: ${site}`,
    { data: { stack: frames.slice(0, 8).map((frame) => frame.trim()) } },
  );
}

/** The roots for the calling context, or undefined before any are installed. */
export function tryWorkspaceRoots(): WorkspaceRoots | undefined {
  const contextRoots = getRunContextRoots();
  if (contextRoots && contextRoots !== PROCESS_ROOTS_VIEW) return contextRoots;
  if (!contextRoots && hasForeignSessionRoots()) warnAmbiguousFallback();
  return processRoots ?? undefined;
}

/**
 * The roots for the calling context: the active run's session roots when
 * called inside a run, otherwise the process roots.
 */
export function workspaceRoots(): WorkspaceRoots {
  return tryWorkspaceRoots() ?? requireProcessRoots();
}
