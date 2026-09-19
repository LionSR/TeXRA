/**
 * Per-workspace roots: the four host services whose value depends on which
 * paper (workspace folder) a piece of code is working on. They live on the
 * owning `SessionHandle` rather than on the process-wide `platform()` object,
 * so one process can hold many sessions, each rooted in its own folder.
 *
 * Resolution is by hand, not by ambient scope: a caller answers for the
 * workspace whose roots it was given — a tool call's `call.roots`, a run's
 * `session.roots`, a host command's `session.roots`. The `AsyncLocalStorage`
 * frame this module used to carry is gone (#12421), and the process-wide
 * holder that survived it is gone too: `SessionHandleInit.roots` is required,
 * so every session is opened over roots its composition root named, and this
 * module declares the record without holding one.
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
