/**
 * Host-neutral types used by settings-view controller and handler wiring.
 *
 * Each wiring helper accepts a minimal "host port" so extension (VS Code) and
 * desktop (Electron) can share the per-domain logic without coupling to a
 * particular transport or UI surface.
 */
import type { StateStore } from '@platform/interfaces';

/** Sends a single message to the settings webview. */
export type SettingsRespond = (message: unknown) => void | PromiseLike<unknown>;

/** Host-neutral state ports used across most settings-view domains. */
export interface SettingsStatePorts {
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
}
