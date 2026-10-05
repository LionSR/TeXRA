/**
 * Per-workspace roots: the four host services whose value depends on which
 * paper (workspace folder) a piece of code is working on. They live on the
 * owning `SessionHandle` rather than on a process-wide object,
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
import type { SettingHost } from '@shared/state/stateSettings';

import type { ConfigProvider, StateStore } from './interfaces';

/** One workspace's host services: its folder, storage, configuration and
 *  state stores, as the session opened over it holds them. */
export interface WorkspaceRoots {
  /**
   * The product host this process is, named by its composition root. The
   * catalog rows whose slot differs by host and the tool gate's
   * `unavailableHosts` read it from here, so a read answers for the host that
   * opened these roots rather than for a default.
   */
  readonly host: SettingHost;
  /** Canonical physical workspace root, or undefined when no folder is open. */
  readonly workspace: string | undefined;
  /** Application-owned storage for this project's TeXRA 1.0 state. Custom
   * hosts must keep this separate from earlier release storage directories;
   * session services use this exact root without importing previous state. */
  readonly storage: string;
  /**
   * Cross-workspace global storage root. Process-wide by construction — every
   * host derives it from the one storage root it opened — and carried here
   * rather than as a process-wide value so the storage paths have a single
   * carrier.
   */
  readonly globalStorage: string;
  /** Workspace-scoped configuration (project `.texra/config.json` plus global). */
  readonly config: ConfigProvider;
  /** Workspace-scoped key-value state. */
  readonly workspaceState: StateStore;
  /**
   * Settings shared by every checkout of this workspace's git repository
   * (the catalog's `repoState` slot), in the global database.
   */
  readonly repoState: StateStore;
  /**
   * Process-wide application state: one of the slots the settings catalog
   * resolves a row against (`config`, `workspaceState`, `repoState`,
   * `globalState`).
   * Process-wide by construction like {@link globalStorage}, and carried here
   * rather than as a process-wide value so a caller that has resolved its roots holds
   * every slot. Inside Effect the owner is the `AppState` service.
   */
  readonly globalState: StateStore;
}
