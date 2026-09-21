/**
 * Platform Abstraction Layer — Composition Root.
 *
 * Single frozen context initialized once at startup by the host
 * (VS Code, CLI, Electron). All core business logic accesses
 * platform services through `platform()` or the convenience
 * facades in `@agent/core/`.
 *
 * Pattern: Composition Root (Mark Seemann) + Frozen Object.
 */
import type { AgentDirectoriesPort, LifecycleHost } from './interfaces';

/**
 * The process-true platform services a host must provide.
 * Frozen after initialization — immutable for the lifetime of the process.
 *
 * The filesystem is not here: it is Effect's own `FileSystem` service, served
 * by `@effect/platform-node` through `installProcessRuntime`, with the rooted
 * `WorkspaceFs` / `StorageFs` views over it on the session.
 *
 * The secret store and the application state store are not here either: they
 * are the `Secrets` and `AppState` Effect services, provided once per process
 * by `installProcessRuntime`, with `WorkspaceRoots.globalState` carrying the
 * state store for the settings slots below the Effect boundary.
 *
 * Per-workspace services (the workspace root, its storage paths, its config
 * and its state) are not here: they are `WorkspaceRoots`
 * (`@platform/workspaceRoots`), carried by each `SessionHandle`, so one
 * process can hold sessions rooted in several folders.
 *
 * The resume port and the editor language-model bridge are not here either:
 * a root hands both straight to `installProcessRuntime`, served as the
 * `AgentResume` and `LanguageModel` Effect services and read only there.
 *
 * Note on logging: diagnostics are their own subsystem. Hosts install their
 * log sink via `logSink.setLogSink` directly; the platform abstraction doesn't
 * carry a log backend.
 */
export interface Platform {
  readonly lifecycle: LifecycleHost;
  readonly agentDirectories: AgentDirectoriesPort;
  /**
   * Surfaces a tool-missing error to the user. The VS Code host is the only
   * one with a UI for it; the others omit it, and callers treat an absent
   * port as a no-op. Declared here rather than behind a name of its own: the
   * type said nothing the one field does not.
   */
  readonly toolMissingHandler?: (
    message: string,
    openDocsCommand?: string,
  ) => void | Promise<void>;
}

let _platform: Readonly<Platform> | null = null;

/**
 * Initialize the platform. Must be called exactly once at startup,
 * before any core business logic runs.
 */
export function initPlatform(services: Platform): void {
  _platform = Object.freeze(services);
}

/**
 * Get the active platform context.
 * Throws if `initPlatform()` hasn't been called yet.
 */
export function platform(): Readonly<Platform> {
  if (!_platform) {
    throw new Error(
      'Platform not initialized — call initPlatform() before using platform services.',
    );
  }
  return _platform;
}

/**
 * Get the active platform context, or null if not yet initialized.
 *
 * Use this in facade modules that need to tolerate access before
 * `initPlatform()` has been called.
 */
export function tryPlatform(): Readonly<Platform> | null {
  return _platform;
}
