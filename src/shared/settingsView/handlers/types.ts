/**
 * Host-neutral types used by shared settings-view handler modules.
 *
 * Each handler accepts a minimal "host port" so extension (VS Code) and
 * desktop (Electron) can share the per-domain logic without coupling to a
 * particular transport or UI surface.
 */
import type { StateStore } from '@platform/interfaces/state';

/** Sends a single message to the settings webview. */
export type SettingsRespond = (message: unknown) => void | PromiseLike<unknown>;

/** Host-neutral state ports used across most domains. */
export interface SettingsStatePorts {
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
}
